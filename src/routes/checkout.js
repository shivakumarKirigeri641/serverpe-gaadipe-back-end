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

const router = express.Router();

const WA_NUMBER = process.env.WHATSAPP_BUSINESS_PHONENUMBER || '916363271302';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

router.get('/pay/:token', async (req, res) => {
  const pay = await db.one(
    `SELECT p.*, u.mobile, u.wa_profile_name, v.reg_no, v.maker, v.model, pl.duration_days
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
      <p class="muted">Monitoring for <b>${esc(pay.reg_no || 'your vehicle')}</b> is active.
      The confirmation and invoice are in your WhatsApp chat.</p>
      <p><a href="https://wa.me/${WA_NUMBER}">Back to WhatsApp</a></p></div>`));
  }

  const gross = pay.amount_paise / 100;
  const taxable = gross / 1.18;
  const gst = gross - taxable;
  const vehicleName = [pay.maker, pay.model].filter(Boolean).join(' ')
    .toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase());

  res.send(page('Checkout', `
<div class="card">
  <h1>Order summary</h1>
  <div class="veh">${esc(pay.reg_no || '')}</div>
  ${vehicleName ? `<div class="muted">${esc(vehicleName)}</div>` : ''}
  <div class="row" style="margin-top:12px"><span>Plan</span>
    <b>GaadiPe Watch · ${pay.duration_days || 28} days</b></div>
  <div class="row"><span>Amount</span><b>₹${taxable.toFixed(2)}</b></div>
  <div class="row"><span>GST @ 18%</span><b>₹${gst.toFixed(2)}</b></div>
  <div class="row total"><span>Total payable</span><b>₹${gross.toFixed(2)}</b></div>
</div>

<div class="card">
  <h1>What you get</h1>
  <ul>
    <li>Daily checks on this vehicle</li>
    <li>A message the moment a new challan appears</li>
    <li>Reminders before insurance, PUC or fitness expires</li>
    <li>Full details: owner, financer, policy numbers</li>
    <li>GST invoice on WhatsApp</li>
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

<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  var btn = document.getElementById('pay'), err = document.getElementById('err');
  btn.onclick = function () {
    btn.disabled = true; err.textContent = '';
    var rz = new Razorpay({
      key: ${JSON.stringify(rzp.KEY)},
      order_id: ${JSON.stringify(pay.order_id)},
      amount: ${pay.amount_paise},
      currency: 'INR',
      name: 'GaadiPe',
      description: ${JSON.stringify(`Watch — ${pay.reg_no || ''}`)},
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
              location.href = 'https://wa.me/${WA_NUMBER}';
            } else {
              err.textContent = out.message || 'We could not confirm the payment yet. Please check WhatsApp in a minute.';
              btn.disabled = false; btn.textContent = 'Pay again';
            }
          })
          .catch(function () {
            // The money is taken; the reconciler will finish the job within a
            // minute, so send them back rather than inviting a second payment.
            location.href = 'https://wa.me/${WA_NUMBER}';
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
});

/* ------------------------------------------------------- the success callback */

router.post('/pay/:token/verify', express.json(), async (req, res) => {
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
});

module.exports = router;
