/**
 * src/routes/payments.js
 * ---------------------------------------------------------------------------
 * Razorpay's webhook.
 *
 *   POST /serverpe/platform/gaadipe/v1/public/users/payments/webhook
 *
 * The same three rules as Meta's webhook, for the same reasons, except the
 * stakes are money rather than messages:
 *
 *   1. VERIFY THE SIGNATURE. This URL grants paid subscriptions. Unsigned, it
 *      grants them to anyone who learns it.
 *
 *   2. ANSWER 200 IMMEDIATELY, then work. Razorpay retries for 24 hours on any
 *      non-200 or slow reply, and a retry storm on a slow database is how one
 *      failure becomes many.
 *
 *   3. BE IDEMPOTENT. Retries are normal, not exceptional. Activating twice
 *      gives away a free month and pays a partner twice for one sale.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../db');
const rzp = require('../pay/razorpay');
const billing = require('../pay/billing');

const router = express.Router();

/** Events we act on. Everything else is recorded and ignored. */
const ACTED = new Set(['payment_link.paid', 'payment.captured', 'refund.processed']);

router.post('/payments/webhook', (req, res) => {
  const verdict = rzp.verifyWebhook(req.rawBody, req.get('x-razorpay-signature'));

  if (verdict === 'bad' || verdict === 'missing') {
    console.warn('[pay] rejected webhook: signature %s', verdict);
    // Emailed to the admin (user, 2026-09-29): a real payment's webhook
    // rejected means a fleet payment is never marked paid. Once per open alert.
    require('../admin/alerts').raise({
      key: 'razorpay_webhook_rejected', severity: 'critical', source: 'payments',
      title: 'Razorpay webhook rejected',
      description: `A Razorpay webhook arrived with a ${verdict} signature and was ignored. If a real payment was behind it, `
        + 'it was not recorded here (fleet payments depend on this). Check that the webhook secret in the Razorpay dashboard '
        + 'matches RAZORPAY_WEBHOOK on the server, and that no other webhook (e.g. QuizPe) points at this URL.',
      detail: { verdict, event: req.body?.event || null, at: new Date().toISOString() },
    }).catch(() => {});
    // 200 regardless: a 4xx would make Razorpay retry a request we will never
    // accept, for 24 hours.
    return res.sendStatus(200);
  }
  if (verdict === 'unset') {
    console.warn('[pay] RAZORPAY_WEBHOOK not set — accepting unverified webhook');
  }

  res.sendStatus(200);
  // A properly signed webhook: whatever was wrong with the secret is fixed.
  if (verdict === 'ok') require('../admin/alerts').clear('razorpay_webhook_rejected', 'A signed webhook arrived').catch(() => {});
  handle(req.body).catch(e => console.error('[pay] handling failed:', e.message));
});

async function handle(body) {
  const event = body?.event;
  if (!event) return;

  const payload = body.payload || {};
  const payment = payload.payment?.entity;
  const link = payload.payment_link?.entity;
  const refundEntity = payload.refund?.entity;

  // Every event is logged, acted on or not: when a customer says "I paid", the
  // answer has to be in the database.
  await db.query(
    `INSERT INTO event_log (kind, detail) VALUES ('razorpay_webhook', $1)`,
    [JSON.stringify({ event,
                      payment_id: payment?.id || null,
                      link_id: link?.id || null,
                      reference_id: link?.reference_id || payment?.notes?.reference_id || null,
                      amount: payment?.amount ?? link?.amount ?? null,
                      status: payment?.status || link?.status || null,
                      // Why an attempt failed, as Razorpay says it (operations
                      // module, 2026-09-25): failure analytics read these.
                      method: payment?.method || null,
                      error_code: payment?.error_code || null,
                      error_reason: payment?.error_reason || null,
                      error_source: payment?.error_source || null,
                      error_step: payment?.error_step || null,
                      error_description: payment?.error_description ? String(payment.error_description).slice(0, 200) : null })]);

  // A failed attempt is an event of its own, once per Razorpay payment, on the
  // payment row it was for — so the payment funnel can count it.
  if (event === 'payment.failed' && payment?.id) {
    const ref = String(payment?.notes?.reference_id || '');
    const rowId = Number(ref.startsWith('gp-') ? ref.split('-')[1] : ref) || null;
    require('../events/track').fire({
      key: `pfail:${payment.id}`, name: 'payment_failed', channel: 'system', paymentId: rowId,
      status: payment.error_reason || 'failed', errorCode: payment.error_code || null, amountPaise: payment.amount ?? null,
      meta: { method: payment.method || null, reason: payment.error_reason || null, source: payment.error_source || null,
              step: payment.error_step || null, description: payment.error_description ? String(payment.error_description).slice(0, 200) : null },
    });
    require('../util/activity').log('❌', `Payment try failed · ₹${(Number(payment.amount || 0) / 100).toFixed(2)} · ${String(payment.error_reason || 'failed').replace(/_/g, ' ')}`,
      { who: payment.contact ? require('../util/activity').who(null, payment.contact) : null, detail: [payment.method ? `by ${payment.method}` : null, rowId ? `payment GP-T-${rowId}` : null] });
  }

  if (!ACTED.has(event)) {
    console.log('[pay] %s (recorded, no action)', event);
    return;
  }

  if (event === 'refund.processed') {
    const r = await billing.refund({
      razorpayPaymentId: refundEntity?.payment_id,
      refundId: refundEntity?.id,
      raw: refundEntity,
    });
    console.log('[pay] refund %s -> %s', refundEntity?.payment_id,
      r.reversed ? 'reversed' : r.reason);
    if (r.reversed) await notifyRefund(r.payment);
    return;
  }

  // Our own payments row id travels as reference_id, so what the money was for
  // never depends on anything the customer could have edited.
  const reference = link?.reference_id || payment?.notes?.reference_id;
  if (!reference) {
    console.warn('[pay] %s with no reference_id — cannot match', event);
    return;
  }

  // A fleet's quotation or renewal link (user, 2026-09-29): "fl-<fleet_payments.id>".
  if (String(reference).startsWith('fl-')) {
    if (event !== 'payment_link.paid' && !(event === 'payment.captured' && payment?.notes?.fleet_payment_id)) return;
    const fpId = Number(String(reference).slice(3));
    const out = await require('../fleet/fleets').markPaid(fpId, { razorpayPaymentId: payment?.id || null })
      .catch((e) => ({ ok: false, reason: e.message }));
    console.log('[pay] fleet payment %s -> %s', fpId, out.ok ? 'paid' : out.reason);
    return;
  }

  // "gp-42-m1k9x" -> 42. Older links carried the bare id, so both are accepted.
  const rowId = Number(String(reference).startsWith('gp-')
    ? String(reference).split('-')[1]
    : reference);
  if (!Number.isFinite(rowId)) {
    console.warn('[pay] unreadable reference_id %s', reference);
    return;
  }

  const result = await billing.activate({
    paymentRowId: rowId,
    razorpayPaymentId: payment?.id || link?.id,
    orderId: payment?.order_id || link?.order_id,
    raw: payment || link,
  });

  if (!result.activated) {
    console.log('[pay] %s ref=%s -> %s', event, reference, result.reason);
    return;
  }
  if (result.oneTime) console.log('[pay] one-time report paid (payment %d)', result.payment.id);
  else if (result.checks) console.log('[pay] check pack paid: %d checks (payment %d)', result.checks, result.payment.id);
  else console.log('[pay] activated subscription %d until %s',
    result.subscription.id, result.endsOn.toISOString().slice(0, 10));

  await notifyPaid(result);
}

/* ------------------------------------------------------------- telling them */

/**
 * Confirmation is sent from here rather than from billing.js: money moving and
 * a message going out are different concerns, and a WhatsApp outage must never
 * roll back a payment.
 */
async function notifyPaid(result) {
  const send = require('../whatsapp/send');
  const gateway = require('../vehicle/gateway');
  const report = require('../whatsapp/report');

  const user = await db.one(
    `SELECT mobile, wa_profile_name FROM users WHERE id = $1`, [result.payment.user_id]);
  if (!user) return;

  // Replace vehicle (2026-10-13): its own confirmation — no report, so not the purchase email.
  if (result.plan?.kind === 'replace') {
    await notifyReplaced(result, user).catch((e) => console.error('[pay] replace confirmation failed:', e.message));
    return;
  }
  // A check pack (migration 213): the checks, until when, and the GST invoice — no report, so not the purchase email.
  if (result.plan?.kind === 'checks') {
    await notifyChecks(result, user).catch((e) => console.error('[pay] checks confirmation failed:', e.message));
    return;
  }

  // FIRST, BEFORE ANY MESSAGE GOES OUT. GaadiPe is web-only for now — there is
  // no WhatsApp number — so the email below is the only thing the customer will
  // actually receive, and queueing it must not sit behind sends that will fail.
  // A free report (₹0) is not a purchase: the referral reward email covers it.
  if (Number(result.payment.amount_paise) > 0 && result.payment.gateway !== 'free') {
    await require('../mail/customer').queuePurchase(result.payment.user_id, result.payment.id)
      .catch((e) => console.error('[pay] could not queue the purchase email:', e.message));
  }

  const veh = result.vehicleId
    ? await db.one(`SELECT reg_no FROM vehicles WHERE id = $1`, [result.vehicleId])
    : null;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = (d) => `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const ends = result.endsOn ? fmt(result.endsOn) : null;   // none for the one-time report (REPORT11)
  const amount = (result.payment.amount_paise / 100).toFixed(result.payment.amount_paise % 100 ? 2 : 0);  // ₹10.62 stays ₹10.62

  if (result.plan?.kind === 'report') {
    await notifyReportPaid(result, user, veh, { ends, amount });
    return;
  }

  // 1. The receipt. Short, and answers the only question they have right now:
  //    did it work, and until when.
  await send.text(user.mobile,
    'Payment received ✅\n\n'
    + `₹${amount} · ${veh ? `*${veh.reg_no}*` : 'your plan'}\n`
    + `Watching until *${ends}*\n\n`
    + 'I check for new challans, and I will warn you before insurance, PUC, road tax '
    + 'or fitness runs out — however far off that is.\n\n'
    + 'Nothing will be charged automatically — I will remind you before it ends.');

  // 2. The vehicle as it stands today — as a message to read now, and as a
  //    numbered PDF to keep. Someone who has just paid wants to see what they
  //    bought, not wait a day for the first check to run.
  if (veh) {
    try {
      // Fresh for what was just paid for (vehicle/rcConfirm.ownerRefresh; once a day per vehicle).
      await require('../vehicle/rcConfirm').ownerRefresh({ regNo: veh.reg_no, userId: user.id, why: 'paid · first message' });
      const data = await gateway.full(veh.reg_no);
      if (data?.success) {
        await send.text(user.mobile, await report.buildFor(data, { detailed: true, mobile: user.mobile }));

        const reports = require('../pay/report');
        const paidFrom = result.payment.raw?.paid_from || {};
        const { report: doc } = await reports.issue({
          userId: result.payment.user_id,
          vehicleId: result.vehicleId,
          paymentId: result.payment.id,
          subscriptionId: result.subscription.id,
          regNo: veh.reg_no,
          data,
          requester: {
            mobile: user.mobile,
            name: user.wa_profile_name,
            ip: paidFrom.ip,
            userAgent: paidFrom.userAgent,
            channel: paidFrom.channel || 'whatsapp',
          },
        });
        // The WhatsApp copy: the important facts only, no offence list (2026-10-24, reports.whatsappPdf).
        await send.document(user.mobile, await reports.whatsappPdf(doc), {
          filename: `${doc.report_number}.pdf`,
          caption: `📋 Vehicle report ${doc.report_number} — ${veh.reg_no}`,
        });
      }
    } catch (e) {
      console.warn('[pay] could not send post-payment report:', e.message);
    }
  }

  await sendInvoice(user, result.payment.id);
}

/**
 * The full report was bought.
 *
 * Order matters: the report first, because it is what they paid for and the
 * one thing they are waiting to see; what else the payment included second;
 * the invoice last.
 */
async function notifyReportPaid(result, user, veh, { ends, amount }) {
  const send = require('../whatsapp/send');

  await send.text(user.mobile,
    'Payment received ✅\n\n'
    + `₹${amount} · full report${result.oneTime ? ' (one time)' : ''}${veh ? ` for *${veh.reg_no}*` : ''}`);

  const delivered = await deliverPaidReport(result.payment.id, { withText: true });
  if (!delivered.ok) {
    // Paid and nothing delivered is the worst outcome here, so say so and leave
    // a way back rather than going quiet. "report" retries this same function.
    await send.buttons(user.mobile,
      'Our records source is slow right now, so your report is not ready yet. '
      + 'Tap below in a few minutes and I will send it. Your payment is safe.',
      [{ id: 'download_report', title: 'Send my report' },
       { id: 'menu',            title: 'Menu' }]);
  }

  // The one-time report (REPORT11): no monitoring to describe — what they have, and the ₹19 if they want alerts later.
  if (result.oneTime) {
    await send.buttons(user.mobile,
      `📄 Your full report for *${veh ? veh.reg_no : 'this vehicle'}* is in *My reports*.\n\n`
      + 'This was a one-time report — no alerts for this vehicle. Want new-challan alerts and expiry warnings for '
      + '28 days? Check the vehicle again and choose *Report + alerts*.'
      + (delivered.ok && veh ? '\n\n_Selling or buying? *Share report* gives a summary link you can forward._' : ''),
      [delivered.ok && veh ? { id: 'share_report', title: 'Share report' } : { id: 'download_report', title: 'My report' },
       { id: 'invoice',         title: 'My GST invoice' },
       { id: 'check_another',   title: 'Check a vehicle' }]);
    await sendInvoice(user, result.payment.id).catch(() => {});
    return;
  }

  await send.buttons(user.mobile,
    `🔔 *${veh ? veh.reg_no : 'Your vehicle'}* is being watched.\n\n`
    + `New challans: I check until *${ends}*.\n`
    + 'Insurance, PUC, road tax, fitness and permit: I will warn you before each one '
    + 'expires, whenever that is — no end date.\n\n'
    + 'Nothing renews automatically.\n\n'
    + 'Everything is one tap away below.'
    + (delivered.ok && veh ? '\n\n_Selling or buying? *Share report* gives a summary link you can forward._' : ''),
    // The report was just sent, so its place goes to "Share report" (2026-10-15, site/shares.js).
    [delivered.ok && veh ? { id: 'share_report', title: 'Share report' } : { id: 'download_report', title: 'My report' },
     { id: 'invoice',         title: 'My GST invoice' },
     { id: 'check_another',   title: 'Check a vehicle' }]);
  if (veh) {
    await require('../db').query(`UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1`,
      [user.mobile, JSON.stringify({ pending_reg: veh.reg_no })]).catch(() => {});
  }

  await sendInvoice(user, result.payment.id);
}

/**
 * Issue and send the report a paid report-plan payment bought.
 *
 * Idempotent per payment: if the report already exists it is re-sent, not
 * re-issued. The download window runs from the PAYMENT, not from delivery, so a
 * report recovered a day late does not quietly gain a day.
 *
 * Returns { ok, reason }.
 */
async function deliverPaidReport(paymentId, { withText = false } = {}) {
  const send = require('../whatsapp/send');
  const gateway = require('../vehicle/gateway');
  const report = require('../whatsapp/report');
  const settings = require('../util/settings');
  const reports = require('../pay/report');

  const pay = await db.one(
    `SELECT p.*, u.mobile, u.wa_profile_name, v.reg_no, pl.kind AS plan_kind
       FROM payments p
       JOIN users u ON u.id = p.user_id
       JOIN plans pl ON pl.id = p.plan_id
       LEFT JOIN vehicles v ON v.id = (p.raw->>'vehicle_id')::bigint
      WHERE p.id = $1`, [paymentId]);
  if (!pay || pay.status !== 'paid' || pay.plan_kind !== 'report' || !pay.reg_no) {
    return { ok: false, reason: 'not_a_paid_report' };
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = (d) => `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

  let doc = await db.one(`SELECT * FROM vehicle_reports WHERE payment_id = $1`, [pay.id]);

  // Feature Flags: reports switched off — the customer is told it is coming.
  if (!doc && !(await require('../util/flags').on('report_generation'))) return { ok: false, reason: 'reports_paused' };

  if (!doc) {
    const validDays = await settings.num('report_valid_days', 7);
    const validUntil = new Date(new Date(pay.paid_at || Date.now()).getTime()
      + validDays * 24 * 60 * 60 * 1000);
    if (validUntil <= new Date()) return { ok: false, reason: 'expired' };

    let data;
    try {
      /* A PAID REPORT IS FRESH (user, 2026-10-20): not the cached copy of an earlier check (the RC
         cache is a day) — one fresh lookup first (ULIP, then IDSPay; once a day per vehicle, so the
         message and the PDF of one purchase pay once), stored, then read below. */
      await require('../vehicle/rcConfirm').ownerRefresh({ regNo: pay.reg_no, userId: pay.user_id, why: 'paid report' });
      // The whole challan list, not the ten-row preview the chat uses: the PDF
      // lists every pending challan, and the report is what was paid for.
      data = await gateway.full(pay.reg_no, { challans: 'all' });
    } catch (e) {
      data = null;
    }
    if (!data?.success) {
      console.error('[pay] report for payment %d not issued: %s', pay.id, data?.error || 'lookup failed');
      return { ok: false, reason: 'lookup_failed' };
    }
    // The e-Challan service did not answer (user, 2026-09-27): one more try
    // before a paid report goes out without challans. RC and FASTag come from
    // the cache, so only the challan call is repeated.
    if (!data.challans) {
      const again = await gateway.full(pay.reg_no, { challans: 'all' }).catch(() => null);
      if (again?.success && again.challans) data = again;
      else console.warn('[pay] report for payment %d: e-Challan still not answering — issued without challans', pay.id);
    }

    if (withText) await send.text(pay.mobile, await report.buildFor(data, { detailed: true, mobile: pay.mobile }));

    const paidFrom = pay.raw?.paid_from || {};
    const consent = await require('../pay/consent').forPayment({
      paymentRowId: pay.id, userId: pay.user_id,
      vehicleId: pay.raw?.vehicle_id ? Number(pay.raw.vehicle_id) : null,
    }).catch(() => null);
    ({ report: doc } = await reports.issue({
      consent,
      userId: pay.user_id,
      vehicleId: pay.raw?.vehicle_id || null,
      paymentId: pay.id,
      subscriptionId: pay.subscription_id,
      regNo: pay.reg_no,
      data,
      validUntil,
      requester: {
        mobile: pay.mobile,
        name: pay.wa_profile_name,
        ip: paidFrom.ip,
        userAgent: paidFrom.userAgent,
        channel: paidFrom.channel || 'whatsapp',
      },
    }));
  }

  const until = fmt(new Date(doc.valid_until));
  const link = base ? `\n${base}/report/${doc.access_token}` : '';
  // The PDF alone — no link beside it (2026-10-19, SCAM strikes); the link only as a button if it fails.
  // The WhatsApp copy: the important facts only, no offence list (2026-10-24, reports.whatsappPdf).
  const waFile = doc.pdf_path ? await reports.whatsappPdf(doc) : null;
  let sent = waFile
    ? await send.document(pay.mobile, waFile, {
        filename: `${doc.report_number}.pdf`,
        caption: `📋 GaadiPe report ${doc.report_number} — ${pay.reg_no}\nDownload again any time until ${until} from My reports.`,
      })
    : { ok: false };
  /* THE CHAT WINDOW IS CLOSED (2026-10-24: gp_report_ready_v1 approved, Utility, with a document header) —
     e.g. paid later, or on the website: the approved template, the report PDF attached at its top.
     Values: name, vehicle, report number, monitoring active till. Buttons, in the template's order:
     "Thanks, Got it" (-> the menu), "Check another vehicle", "My reports" — all three quick replies, as approved. */
  if (!sent.ok && sent.error === 'window_closed' && waFile) {
    const tpl = String(await require('../util/settings').get('wa_template_report_ready', '') || '').trim();
    if (tpl && (await send.mayStart(pay.mobile).catch(() => ({ ok: false }))).ok) {
      const up = await send.uploadPdf(waFile, `${doc.report_number}.pdf`);
      if (up.ok) {
        const sub = pay.subscription_id ? await db.one(`SELECT ends_on FROM subscriptions WHERE id = $1`, [pay.subscription_id]).catch(() => null) : null;
        const name = String(pay.wa_profile_name || '').trim().split(/\s+/)[0] || 'there';
        sent = await send.template(pay.mobile, tpl,
          [name, pay.reg_no, doc.report_number, sub?.ends_on ? fmt(new Date(sub.ends_on)) : until],
          { language: await require('../util/settings').get('wa_template_language', 'en'),
            buttons: ['menu', 'check_another', 'my_reports'], headerDocument: { id: up.id, filename: `${doc.report_number}.pdf` } })
          .catch((e) => ({ ok: false, error: e.message }));
      }
    }
  }
  if (!sent.ok && link) {
    const btn = await send.ctaUrl(pay.mobile,
      `📋 GaadiPe report ${doc.report_number} — ${pay.reg_no}\n\nThe PDF could not be attached here. Tap below to open it (until ${until}).`,
      { text: 'Open my report', url: link.trim() }).catch(() => ({ ok: false }));
    if (!btn.ok) await send.text(pay.mobile, `📋 Your GaadiPe report ${doc.report_number} could not be attached. Open it here until ${until}:${link}`);
  }
  // The email tip after a paid report (2026-10-15, whatsapp/flow.js emailNudge): last, a few
  // seconds after the report and its buttons, and only if they have no confirmed email.
  if (sent.ok || link) {
    setTimeout(() => require('../whatsapp/flow').emailNudge(pay.mobile, 'report').catch(() => {}), 8000).unref?.();
  }
  // Once per report: re-sending it later (My reports) is not a new delivery.
  require('../events/track').fire({
    key: `delivered:${doc.id}`, name: 'report_delivered', channel: 'whatsapp',
    userId: pay.user_id, mobile: pay.mobile, regNo: pay.reg_no, paymentId: pay.id,
    status: sent.ok ? 'ok' : (link ? 'link_only' : 'failed'),
    meta: { report_number: doc.report_number, via: sent.ok ? 'pdf' : 'link' },
  });
  return { ok: true, report: doc };
}

/**
 * REPLACE VEHICLE PAID (2026-10-13; pay/replace.js): what moved, until when, and
 * the GST invoice — on WhatsApp (with buttons), by email with the invoice attached,
 * and as a browser notification. Any of them may be unavailable; none blocks another.
 */
async function notifyReplaced(result, user) {
  const send = require('../whatsapp/send');
  const r = result.replaced || {};
  const day = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const ends = day(result.endsOn);
  const amount = (Number(result.payment.amount_paise) / 100).toFixed(Number(result.payment.amount_paise) % 100 ? 2 : 0);
  const body = '✅ *Vehicle replaced*\n\n'
    + `Monitoring moved from *${r.from_reg}* to *${r.to_reg}* — alerts until *${ends}*.\n\n`
    + `🔕 ${r.from_reg} is off your list and its alerts have stopped; its report stays in My reports.\n`
    + `🔔 ${r.to_reg}: new challans, and a warning before insurance, PUC, road tax, fitness or permit expires.\n\n`
    + `₹${amount} paid — your GST invoice follows.`;
  const tapped = await send.buttons(user.mobile, body, [{ id: 'my_monitoring', title: 'My monitoring' },
    { id: 'check_another', title: 'Check vehicle' }, { id: 'menu', title: 'Menu' }]).catch(() => ({ ok: false }));
  if (!tapped.ok) await send.text(user.mobile, body).catch(() => {});
  await sendInvoice(user, result.payment.id);

  // Email, with the invoice, to a confirmed address.
  const u = await db.one(`SELECT email, email_verified_at, email_unsubscribed_at, email_token, display_name FROM users WHERE id = $1`, [result.payment.user_id]);
  if (u?.email && u.email_verified_at) {
    const C = require('../mail/customer');
    const T = require('../mail/templates');
    let invoice = null;
    try { ({ invoice } = await require('../pay/invoice').forPayment(result.payment.id)); } catch (e) { console.warn('[pay] replace invoice: %s', e.message); }
    const card = T.vehicleCard({ reg: r.to_reg, sub: `Replaces ${r.from_reg}`,
      items: [{ label: 'Monitoring', text: `Alerts until ${ends}`, tone: 'good' }] });
    const mail = T.layout({
      tagline: 'Vehicle replaced', badge: { text: 'Monitoring moved', tone: 'good' },
      preheader: `Monitoring moved from ${r.from_reg} to ${r.to_reg}, until ${ends}.`,
      title: `${r.to_reg} is now monitored, until ${ends}`,
      lead: `Hi ${String(u.display_name || '').split(' ')[0] || 'there'}, your monitoring has moved from ${r.from_reg} to ${r.to_reg}. ${r.from_reg} is off your list and its alerts have stopped; its report stays in My reports. ₹${amount} paid — your GST invoice is attached.`,
      intro: [card.html], textBlocks: [card.text],
      cta: { label: 'Open GaadiPe', url: `${C.SITE()}/chat?open=subs` },
      footer: 'You are receiving this because you replaced a vehicle on GaadiPe.',
    });
    const fs = require('fs');
    await C.deliver(u.email, { subject: `${r.to_reg} replaces ${r.from_reg} — GaadiPe`, ...mail,
      attachments: invoice?.pdf_path && fs.existsSync(invoice.pdf_path) ? [{ filename: `${invoice.invoice_number}.pdf`, path: invoice.pdf_path }] : [] },
    u.email_token).catch((e) => console.warn('[pay] replace email: %s', e.message));
  }
  await require('../site/push').toCustomer(result.payment.user_id, {
    title: `✅ ${r.to_reg} replaces ${r.from_reg}`, body: `Monitoring moved — alerts until ${ends}.`,
    url: '/chat?open=subs', tag: `replace-${result.payment.id}`,
  }).catch(() => 0);
}

/* A CHECK PACK PAID (user, 2026-10-26; migration 213): how many checks they now have, until when, and the GST
   invoice. Ready for a vehicle number straight away. */
async function notifyChecks(result, user) {
  const send = require('../whatsapp/send');
  const c = await require('../util/quota').creditsOf(result.payment.user_id);
  const day = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const amount = (Number(result.payment.amount_paise) / 100).toFixed(Number(result.payment.amount_paise) % 100 ? 2 : 0);
  await db.query(`UPDATE whatsapp_sessions SET state = 'owner_start', modified_at = now() WHERE mobile = $1`, [user.mobile]).catch(() => {});
  const body = `✅ *${result.checks} vehicle checks added*\n\n`
    + `You now have *${c.left}* check${c.left === 1 ? '' : 's'}${result.endsOn ? ` — this pack is valid till *${day(result.endsOn)}*` : ''}.\n\n`
    + 'Send any vehicle number, like *KA01AB1234*, to use one. Vehicles you already checked are free to check again, any time.\n\n'
    + `₹${amount} paid — your GST invoice follows.`;
  const tapped = await send.buttons(user.mobile, body, [{ id: 'check_another', title: 'Check vehicle' }, { id: 'menu', title: 'Menu' }])
    .catch(() => ({ ok: false }));
  if (!tapped.ok) await send.text(user.mobile, body).catch(() => {});
  await sendInvoice(user, result.payment.id);
  await require('../site/push').toCustomer(result.payment.user_id, {
    title: `✅ ${result.checks} vehicle checks added`, body: `You have ${c.left} checks${result.endsOn ? `, valid till ${day(result.endsOn)}` : ''}.`,
    url: '/chat', tag: `checks-${result.payment.id}`,
  }).catch(() => 0);
}

/**
 * The GST invoice. Required for a paid supply, and the thing a fleet owner or
 * anyone claiming input credit will ask for later — better issued now than
 * reconstructed on request.
 */
async function sendInvoice(user, paymentId) {
  const send = require('../whatsapp/send');
  const invoices = require('../pay/invoice');
  try {
    const { invoice } = await invoices.forPayment(paymentId);
    const caption = `🧾 Tax invoice ${invoice.invoice_number}\n`
      + `Taxable ₹${(invoice.base_paise / 100).toFixed(2)} · `
      + `GST ₹${((invoice.total_paise - invoice.base_paise) / 100).toFixed(2)} · `
      + `Total ₹${(invoice.total_paise / 100).toFixed(2)}`;

    // The PDF itself, not a link. An invoice is the customer's own document —
    // a link to a file on our server would need us to be reachable, and to be
    // trusted, for as long as they might want it.
    const sent = await send.document(user.mobile, invoice.pdf_path,
      { filename: `${invoice.invoice_number}.pdf`, caption });

    // If the upload fails they must still get the numbers. An invoice that
    // silently did not arrive becomes a support conversation weeks later.
    if (!sent.ok) {
      console.warn('[pay] invoice PDF not delivered (%s) — sent the figures instead', sent.error);
      await send.buttons(user.mobile, caption,
        [{ id: 'invoice', title: 'Send the invoice' }]);
    }
  } catch (e) {
    // A failed invoice must never look like a failed payment.
    console.error('[pay] invoice generation failed:', e.message);
  }
}

async function notifyRefund(payment) {
  const send = require('../whatsapp/send');
  const user = await db.one(`SELECT mobile FROM users WHERE id = $1`, [payment.user_id]);
  if (!user) return;
  await send.text(user.mobile,
    'Your refund has been processed. ✅\n\n'
    + 'Monitoring for that vehicle has stopped. The amount usually appears in your '
    + 'account within 5–7 working days, depending on your bank.');
}

module.exports = router;
// The reconciler sends the same confirmation when it recovers a missed payment,
// so a recovered customer's experience is identical to a normal one.
module.exports.notifyPaid = notifyPaid;
// "report" in the chat retries a paid report that could not be issued at payment time.
module.exports.deliverPaidReport = deliverPaidReport;
