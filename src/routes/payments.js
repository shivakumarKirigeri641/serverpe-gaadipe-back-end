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
    // 200 regardless: a 4xx would make Razorpay retry a request we will never
    // accept, for 24 hours.
    return res.sendStatus(200);
  }
  if (verdict === 'unset') {
    console.warn('[pay] RAZORPAY_WEBHOOK not set — accepting unverified webhook');
  }

  res.sendStatus(200);
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
                      status: payment?.status || link?.status || null })]);

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
  console.log('[pay] activated subscription %d until %s',
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

  const veh = result.vehicleId
    ? await db.one(`SELECT reg_no FROM vehicles WHERE id = $1`, [result.vehicleId])
    : null;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = (d) => `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const ends = fmt(result.endsOn);
  const amount = (result.payment.amount_paise / 100).toFixed(0);

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
    + 'I check every day and message you the moment a new challan appears or a '
    + 'document is close to expiring.\n\n'
    + 'Nothing will be charged automatically — I will remind you before it ends.');

  // 2. The vehicle as it stands today — as a message to read now, and as a
  //    numbered PDF to keep. Someone who has just paid wants to see what they
  //    bought, not wait a day for the first check to run.
  if (veh) {
    try {
      const data = await gateway.full(veh.reg_no);
      if (data?.success) {
        await send.text(user.mobile, await report.buildFor(data, { detailed: true }));

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
        await send.document(user.mobile, doc.pdf_path, {
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
    + `₹${amount} · full report${veh ? ` for *${veh.reg_no}*` : ''}`);

  const delivered = await deliverPaidReport(result.payment.id, { withText: true });
  if (!delivered.ok) {
    // Paid and nothing delivered is the worst outcome here, so say so and leave
    // a way back rather than going quiet. "report" retries this same function.
    await send.text(user.mobile,
      'The Government records service is slow right now, so your report is not ready yet. '
      + 'Reply *report* in a few minutes and I will send it. Your payment is safe.');
  }

  await send.text(user.mobile,
    `🔔 Alerts are on for *${veh ? veh.reg_no : 'your vehicle'}* until *${ends}*.\n\n`
    + 'I will message you if a new challan appears, or before insurance, PUC, road tax, '
    + 'fitness or permit expires. Nothing renews automatically.\n\n'
    + 'Reply *report* to download the report again, or *invoice* for your GST invoice.');

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

  if (!doc) {
    const validDays = await settings.num('report_valid_days', 7);
    const validUntil = new Date(new Date(pay.paid_at || Date.now()).getTime()
      + validDays * 24 * 60 * 60 * 1000);
    if (validUntil <= new Date()) return { ok: false, reason: 'expired' };

    let data;
    try {
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

    if (withText) await send.text(pay.mobile, await report.buildFor(data, { detailed: true }));

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
  const sent = doc.pdf_path
    ? await send.document(pay.mobile, doc.pdf_path, {
        filename: `${doc.report_number}.pdf`,
        caption: `📋 ${doc.report_number} — ${pay.reg_no}\nDownload again until ${until}${link}`,
      })
    : { ok: false };
  if (!sent.ok && link) {
    await send.text(pay.mobile,
      `📋 Your report ${doc.report_number} could not be attached. Download it here until ${until}:${link}`);
  }
  return { ok: true, report: doc };
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
      await send.text(user.mobile, caption + '\n\nReply *invoice* to get the PDF again.');
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
