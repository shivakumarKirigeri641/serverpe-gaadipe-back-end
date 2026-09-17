/**
 * src/routes/checkout.js
 * ---------------------------------------------------------------------------
 * The page between WhatsApp and Razorpay.
 *
 *   GET  /pay/:token     the order summary, with a Pay button
 *   POST /pay/:token/verify   the success callback from Razorpay Checkout
 *
 * WHY A PAGE OF OUR OWN, when a payment link already works: a link ends on
 * Razorpay's site and hands us nothing. We learn about the money only when a
 * webhook arrives, and a webhook can be late, misrouted or lost — one real test
 * payment sat unacknowledged for seven minutes for exactly that reason.
 *
 * Razorpay Checkout, opened from our page, gives the browser a success callback
 * carrying a SIGNED payment id. We verify that signature server-side and
 * activate immediately, so by the time the customer is back in WhatsApp the
 * confirmation, the report and the invoice are already waiting.
 *
 * The webhook and the reconciler stay exactly as they were. This is the fast
 * path; they are what makes it safe for the fast path to fail.
 *
 * NO LOGIN, by design. The token is unguessable, belongs to one payment, and
 * grants nothing except the right to pay that one amount.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../db');
const rzp = require('../pay/razorpay');
const billing = require('../pay/billing');
const settings = require('../util/settings');
const fs = require('fs');

const router = express.Router();

const WA_NUMBER = process.env.WHATSAPP_BUSINESS_PHONENUMBER || '916363271302';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Back to the GaadiPe chat — the APP, not wa.me's web landing page.
 *
 * WHY NOT JUST location.href = wa.me: after a UPI payment the customer returns
 * to the browser from their UPI app, the success callback runs with no tap
 * behind it, and Android Chrome then refuses to hand a wa.me navigation to the
 * WhatsApp app. They are left on a "Continue to chat" web page, which reads as
 * "something went wrong".
 *
 * So: an intent URL on Android (opens WhatsApp or WhatsApp Business, falling
 * back to wa.me), the whatsapp:// scheme on iOS, wa.me elsewhere — tried
 * automatically, AND offered as a big button, because a tap is the one thing
 * every browser lets through.
 */
const WA_JS = `
  var WA_WEB = 'https://wa.me/${WA_NUMBER}';
  function waUrl() {
    var ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) {
      return 'intent://send/?phone=${WA_NUMBER}#Intent;scheme=whatsapp;'
        + 'S.browser_fallback_url=' + encodeURIComponent(WA_WEB) + ';end';
    }
    if (/iPhone|iPad|iPod/i.test(ua)) return 'whatsapp://send?phone=${WA_NUMBER}';
    return WA_WEB;
  }
  function openWhatsApp() { location.href = waUrl(); return false; }
`;
const waButton = (label = 'Open WhatsApp') =>
  `<button onclick="return openWhatsApp()">${esc(label)}</button>
   <p class="muted" style="text-align:center;margin:10px 0 0">
     Not opening? <a href="https://wa.me/${WA_NUMBER}">Tap here</a></p>
   <script>${WA_JS}</script>`;

const page = (title, body) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · GaadiPe</title>
<style>
  :root { --brand:#0F766E; --ink:#0B1F1C; --body:#41514E; --line:#E3ECEA;
          --soft:#F3F8F7; --bad:#B42318; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--soft); color:var(--ink);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:440px; margin:0 auto; padding:20px 16px 40px; }
  .brand { display:flex; align-items:center; gap:10px; margin:8px 0 18px; }
  .brand b { font-size:19px; letter-spacing:-.2px; }
  .brand span { color:var(--body); font-size:12px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px;
          padding:18px; margin-bottom:14px; }
  h1 { font-size:16px; margin:0 0 14px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:7px 0;
         font-size:14px; color:var(--body); }
  .row b { color:var(--ink); font-weight:600; text-align:right; }
  .total { border-top:1px solid var(--line); margin-top:8px; padding-top:12px;
           font-size:17px; color:var(--ink); font-weight:700; }
  .veh { font-size:20px; font-weight:700; letter-spacing:.5px; }
  .muted { color:var(--body); font-size:12.5px; }
  ul { margin:8px 0 0; padding-left:18px; color:var(--body); font-size:13.5px; }
  li { margin:3px 0; }
  button { width:100%; padding:15px; border:0; border-radius:12px;
           background:var(--brand); color:#fff; font-size:16px; font-weight:600;
           cursor:pointer; }
  button:disabled { opacity:.55; }
  a { color:var(--brand); }
  .foot { text-align:center; color:var(--body); font-size:11.5px; margin-top:18px; }
  .err { color:var(--bad); font-size:13.5px; margin-top:10px; text-align:center; }
</style>
</head><body><div class="wrap">
<div class="brand"><b>GaadiPe</b><span>Har gaadi ki kundli.</span></div>
${body}
<div class="foot">Powered by ServerPe App Solutions · GSTIN 29BSMPK7696H1ZT</div>
</div></body></html>`;

/* ------------------------------------------------------------- the summary */

/**
 * Express 4 does not catch a rejected promise from an async handler, and an
 * unhandled rejection stops the process — so one database error on this
 * public page would take the webhooks and the jobs down with it. Every async
 * route here goes through this.
 */
const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error('[checkout] %s %s failed: %s', req.method, req.path, e.message);
  if (res.headersSent) return;
  if (req.method === 'GET') {
    res.status(500).send(page('Something went wrong', `<div class="card">
      <h1>Something went wrong</h1>
      <p class="muted">Please try again in a minute.</p></div>`));
  } else {
    // The money may already be taken; the webhook and the reconciler finish the
    // job, so this must not invite a second payment.
    res.status(500).json({ ok: false, message: 'We could not confirm the payment yet. Please check WhatsApp in a minute.' });
  }
});

router.get('/pay/:token', safe(async (req, res) => {
  const pay = await db.one(
    `SELECT p.*, u.mobile, u.wa_profile_name, v.reg_no, v.maker, v.model, pl.duration_days,
            pl.kind AS plan_kind
       FROM payments p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN plans pl ON pl.id = p.plan_id
       LEFT JOIN vehicles v ON v.id = (p.raw->>'vehicle_id')::bigint
      WHERE p.checkout_token = $1`, [req.params.token]);

  if (!pay) {
    return res.status(404).send(page('Not found', `<div class="card">
      <h1>This payment link is not valid</h1>
      <p class="muted">It may have already been used. Please go back to WhatsApp
      and ask for a new one.</p>
      <p><a href="https://wa.me/${WA_NUMBER}">Open WhatsApp</a></p></div>`));
  }

  if (pay.status === 'paid') {
    return res.send(page('Already paid', `<div class="card">
      <h1>This payment is already complete ✅</h1>
      <p class="muted">${pay.plan_kind === 'report'
        ? `Your full report for <b>${esc(pay.reg_no || 'your vehicle')}</b> has been sent.`
        : `Monitoring for <b>${esc(pay.reg_no || 'your vehicle')}</b> is active.`}
      The confirmation and invoice are in your WhatsApp chat.</p>
      ${waButton('Back to WhatsApp')}</div>`));
  }

  const gross = pay.amount_paise / 100;
  const taxable = gross / 1.18;
  const gst = gross - taxable;
  const vehicleName = [pay.maker, pay.model].filter(Boolean).join(' ')
    .toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase());

  const isReport = pay.plan_kind === 'report';
  const validDays = await settings.num('report_valid_days', 7);
  const planLine = isReport
    ? 'Full vehicle report'
    : `GaadiPe Watch · ${pay.duration_days || 28} days`;
  const benefits = isReport
    ? [`Full report PDF on WhatsApp — download again for ${validDays} days`,
       'Loan / hypothecation, blacklist and NOC status',
       'Challan numbers and most frequent offences',
       'Insurer, policy and PUC references',
       `${pay.duration_days || 28} days of alerts: new challans and document expiry`,
       'GST invoice on WhatsApp']
    : ['Daily checks on this vehicle',
       'A message the moment a new challan appears',
       'Reminders before insurance, PUC or fitness expires',
       'Full details: financer, policy numbers',
       'GST invoice on WhatsApp'];

  res.send(page('Checkout', `
<div id="done" class="card" style="display:none">
  <h1>Payment successful ✅</h1>
  <p class="muted" style="margin:0 0 14px">${isReport
    ? `Your full report for <b>${esc(pay.reg_no || '')}</b> is on its way to your WhatsApp chat.`
    : 'Your confirmation is on its way to your WhatsApp chat.'}
  Opening WhatsApp…</p>
  ${waButton('Open WhatsApp')}
</div>

<div id="main">
<div class="card">
  <h1>Order summary</h1>
  <div class="veh">${esc(pay.reg_no || '')}</div>
  ${vehicleName ? `<div class="muted">${esc(vehicleName)}</div>` : ''}
  <div class="row" style="margin-top:12px"><span>Plan</span>
    <b>${esc(planLine)}</b></div>
  <div class="row"><span>Amount</span><b>₹${taxable.toFixed(2)}</b></div>
  <div class="row"><span>GST @ 18%</span><b>₹${gst.toFixed(2)}</b></div>
  <div class="row total"><span>Total payable</span><b>₹${gross.toFixed(2)}</b></div>
</div>

<div class="card">
  <h1>What you get</h1>
  <ul>
    ${benefits.map(b => `<li>${esc(b)}</li>`).join('')}
  </ul>
  <p class="muted" style="margin:12px 0 0"><b>No auto-renewal.</b>
  Nothing is charged automatically, now or later.</p>
</div>

<div class="card">
  <button id="pay">Pay ₹${gross.toFixed(0)} securely</button>
  <div id="err" class="err"></div>
  <p class="muted" style="margin:12px 0 0;text-align:center">
    By paying you accept our
    <a href="https://gaadipe.in/terms">Terms</a>,
    <a href="https://gaadipe.in/refund">Refund</a> and
    <a href="https://gaadipe.in/privacy">Privacy</a> policies.
  </p>
</div>
</div>

<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  var btn = document.getElementById('pay'), err = document.getElementById('err');
  // Paid: swap the order summary for the success card, and try to open the
  // chat straight away. The card's button covers browsers that block that.
  function done() {
    document.getElementById('main').style.display = 'none';
    document.getElementById('done').style.display = 'block';
    window.scrollTo(0, 0);
    setTimeout(openWhatsApp, 600);
  }
  btn.onclick = function () {
    btn.disabled = true; err.textContent = '';
    var rz = new Razorpay({
      key: ${JSON.stringify(rzp.KEY)},
      order_id: ${JSON.stringify(pay.order_id)},
      amount: ${pay.amount_paise},
      currency: 'INR',
      name: 'GaadiPe',
      description: ${JSON.stringify(`${isReport ? 'Full report' : 'Watch'} — ${pay.reg_no || ''}`)},
      prefill: { contact: ${JSON.stringify('+91' + String(pay.mobile).slice(-10))},
                 name: ${JSON.stringify(pay.wa_profile_name || '')} },
      theme: { color: '#0F766E' },
      // Verified server-side before the customer is told anything: the browser
      // could claim any payment succeeded.
      handler: function (r) {
        btn.textContent = 'Confirming…';
        fetch(location.pathname + '/verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r)
        }).then(function (x) { return x.json(); })
          .then(function (out) {
            if (out.ok) {
              done();
            } else {
              err.textContent = out.message || 'We could not confirm the payment yet. Please check WhatsApp in a minute.';
              btn.disabled = false; btn.textContent = 'Pay again';
            }
          })
          .catch(function () {
            // The money is taken; the reconciler will finish the job within a
            // minute, so send them back rather than inviting a second payment.
            done();
          });
      },
      modal: { ondismiss: function () { btn.disabled = false; } }
    });
    rz.on('payment.failed', function (e) {
      err.textContent = (e.error && e.error.description) || 'Payment failed. Please try again.';
      btn.disabled = false;
    });
    rz.open();
  };
</script>`));
}));

/* ------------------------------------------------------- the success callback */

router.post('/pay/:token/verify', express.json(), safe(async (req, res) => {
  const { razorpay_payment_id: paymentId, razorpay_order_id: orderId,
          razorpay_signature: signature } = req.body || {};

  const pay = await db.one(
    `SELECT * FROM payments WHERE checkout_token = $1`, [req.params.token]);
  if (!pay) return res.status(404).json({ ok: false, message: 'Unknown payment.' });

  // The browser is not trusted. Only Razorpay's signature over
  // "order_id|payment_id" proves this happened.
  if (!rzp.verifyCheckout({ orderId, paymentId, signature })) {
    console.warn('[checkout] bad signature for payment %d', pay.id);
    return res.status(400).json({ ok: false, message: 'Could not verify the payment.' });
  }
  if (orderId !== pay.order_id) {
    console.warn('[checkout] order mismatch: %s vs %s', orderId, pay.order_id);
    return res.status(400).json({ ok: false, message: 'Could not verify the payment.' });
  }

  // The device the payment was made from. Recorded here because this is the
  // only point in the whole flow where a browser exists — WhatsApp gives us no
  // user agent and no IP, so a report issued from a chat has nothing to say
  // about the requester's device except that there wasn't one.
  const requester = {
    ip: req.ip,
    userAgent: req.get('user-agent') || null,
    channel: 'web',
  };
  await db.query(
    `UPDATE payments SET raw = COALESCE(raw,'{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [pay.id, JSON.stringify({ paid_from: requester })]);

  const result = await billing.activate({
    paymentRowId: pay.id, razorpayPaymentId: paymentId, orderId,
    raw: { via: 'checkout' },
  });

  if (result.activated) {
    console.log('[checkout] activated subscription %d from the browser callback',
      result.subscription.id);
    const { notifyPaid } = require('./payments');
    notifyPaid(result).catch(e => console.error('[checkout] notify:', e.message));
  } else {
    // Already handled by the webhook that beat us to it — still a success.
    console.log('[checkout] payment %d already handled (%s)', pay.id, result.reason);
  }

  res.json({ ok: true });
}));

/* ------------------------------------------------------------ the report */

/**
 * Download a paid report while it is valid.
 *
 *   GET /report/:token
 *
 * The token is unguessable and belongs to one report, like the checkout token.
 * After valid_until the link says so plainly instead of 404ing, because the
 * person holding it did pay, and deserves to know why it stopped working.
 */
router.get('/report/:token', safe(async (req, res) => {
  const r = await db.one(
    `SELECT report_number, reg_no, pdf_path, valid_until
       FROM vehicle_reports WHERE access_token = $1`, [req.params.token]);

  if (!r || !r.valid_until) {
    return res.status(404).send(page('Not found', `<div class="card">
      <h1>This report link is not valid</h1>
      <p><a href="https://wa.me/${WA_NUMBER}">Open WhatsApp</a></p></div>`));
  }
  if (new Date(r.valid_until) <= new Date()) {
    return res.status(410).send(page('Link expired', `<div class="card">
      <h1>This download link has expired</h1>
      <p class="muted">The report for <b>${esc(r.reg_no)}</b> could be downloaded until
      ${esc(new Date(r.valid_until).toDateString())}. Send the vehicle number on WhatsApp to
      check today's records.</p>
      <p><a href="https://wa.me/${WA_NUMBER}">Open WhatsApp</a></p></div>`));
  }
  if (!r.pdf_path || !fs.existsSync(r.pdf_path)) {
    console.error('[report] %s file missing at %s', r.report_number, r.pdf_path);
    return res.status(404).send(page('Not available', `<div class="card">
      <h1>This report is not available right now</h1>
      <p class="muted">Reply <b>report</b> on WhatsApp and it will be sent to you.</p>
      <p><a href="https://wa.me/${WA_NUMBER}">Open WhatsApp</a></p></div>`));
  }
  res.set('Cache-Control', 'private, no-store');
  res.download(r.pdf_path, `${r.report_number}.pdf`);
}));

module.exports = router;
