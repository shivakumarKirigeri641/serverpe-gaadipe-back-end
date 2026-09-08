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
  const invoices = require('../pay/invoice');

  const user = await db.one(
    `SELECT mobile, wa_profile_name FROM users WHERE id = $1`, [result.payment.user_id]);
  if (!user) return;

  const veh = result.vehicleId
    ? await db.one(`SELECT reg_no FROM vehicles WHERE id = $1`, [result.vehicleId])
    : null;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = result.endsOn;
  const ends = `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const amount = (result.payment.amount_paise / 100).toFixed(0);

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

  // 3. The GST invoice. Required for a paid supply, and the thing a fleet owner
  //    or anyone claiming input credit will ask for later — better issued now
  //    than reconstructed on request.
  try {
    const { invoice } = await invoices.forPayment(result.payment.id);
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
