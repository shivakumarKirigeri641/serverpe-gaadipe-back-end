/**
 * src/pay/razorpay.js
 * ---------------------------------------------------------------------------
 * Taking money, and knowing for certain that it arrived.
 *
 * PAYMENT LINKS, NOT A CHECKOUT PAGE. GaadiPe has no web app to host a checkout
 * in, and does not want one: the customer is already in WhatsApp, so a link
 * that opens Razorpay's own hosted page is fewer steps and less to go wrong.
 * Razorpay handles UPI, cards, the RBI two-factor dance and the receipt.
 *
 * THE WEBHOOK IS THE ONLY TRUSTWORTHY SIGNAL. After paying, a customer closes
 * the tab, loses signal, or switches apps — the "return" journey cannot be
 * relied on, and any flow that activates a subscription on the customer coming
 * back will sooner or later take money and deliver nothing. Server-to-server
 * webhooks arrive regardless, and are retried for 24 hours.
 *
 * Everything here is idempotent. Razorpay retries, and payments.payment_id is
 * UNIQUE, so the same payment cannot activate two subscriptions or pay a
 * partner twice — the classic way a gateway integration goes wrong.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');

/**
 * WHICH KEYS ARE USED IS DECIDED BY NODE_ENV, never by which keys happen to
 * exist.
 *
 * The first version preferred live keys whenever they were present, which meant
 * that the moment live keys were added to a laptop's .env, every test payment
 * took real money from a real card. Both key pairs living side by side is
 * normal and useful; the environment is what says which is in force.
 *
 * Production without live keys falls back to test keys and says so loudly at
 * boot — a silent fallback would take fake money from real customers.
 */
const LIVE = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const KEY = (LIVE ? process.env.RAZORPAY_LIVE_KEY : process.env.RAZORPAY_TEST_KEY)
  || process.env.RAZORPAY_TEST_KEY || '';
const SECRET = (LIVE ? process.env.RAZORPAY_LIVE_SECRET : process.env.RAZORPAY_TEST_SECRET)
  || process.env.RAZORPAY_TEST_SECRET || '';

// One webhook secret for both modes: the same value is set on the test and the
// live webhook in the Razorpay dashboard, so a signature verifies whichever
// mode sent it.
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK || '';

const isLive = KEY.startsWith('rzp_live');

if (LIVE && !isLive) {
  console.error('[pay] NODE_ENV=production but no live Razorpay key — running on TEST keys');
}
if (!LIVE && isLive) {
  console.error('[pay] refusing to use live keys outside production');
}
const auth = () => 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64');

const configured = () => Boolean(KEY && SECRET);

/*
 * A failed Razorpay call is an admin alert (user, 2026-09-29): when orders or
 * payment links cannot be created, nobody can pay. Only creating things
 * (POST) raises it — a failed lookup is retried by the reconcilers — and the
 * next successful POST clears it.
 */
const alertOn = (e, path) => require('../admin/alerts').raise({
  key: 'razorpay_api_failing', severity: 'critical', source: 'payments', title: 'Razorpay not accepting requests',
  description: `Creating ${path.startsWith('/payment_links') ? 'a payment link' : path.startsWith('/orders') ? 'an order' : path} failed: ${e.message}. `
    + 'Customers may not be able to pay. Check the Razorpay dashboard (account status, API keys) and the server logs.',
  detail: { path, code: e.code || null, message: String(e.message).slice(0, 300) },
}).catch(() => {});

async function call(path, method = 'GET', body) {
  let res;
  const t0 = Date.now();
  const status = require('../util/providerStatus');
  try {
    res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: { Authorization: auth(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    status.record('razorpay', { ok: false, ms: Date.now() - t0, error: err.message });
    if (method === 'POST') await alertOn(err, path);
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (json.error) {
    const e = new Error(json.error.description || 'razorpay error');
    e.code = json.error.code;
    // A customer's own bad input is not an outage.
    const outage = !/BAD_REQUEST_ERROR/.test(String(e.code || ''));
    status.record('razorpay', { ok: !outage, ms: Date.now() - t0, error: outage ? `${e.code}: ${e.message}` : null });
    if (method === 'POST' && outage) await alertOn(e, path);
    throw e;
  }
  status.record('razorpay', { ok: true, ms: Date.now() - t0 });
  if (method === 'POST') await require('../admin/alerts').clear('razorpay_api_failing', 'Razorpay accepted a request again').catch(() => {});
  return json;
}

/**
 * A payment link for one purchase.
 *
 * `reference_id` carries our own payments row id, so the webhook can find what
 * this money was for without trusting anything the customer could have edited.
 * `notes` carries the rest for human eyes in the dashboard — a refund enquiry
 * six weeks later is answered by looking at the payment, not by a join.
 *
 * reminder_enable is off: Razorpay would message the customer about an unpaid
 * link, and GaadiPe does not send unsolicited messages, including through a
 * third party.
 */
async function createLink({ amountPaise, mobile, name, description, referenceId, notes = {}, expiresInMinutes = 60 * 24 }) {
  return call('/payment_links', 'POST', {
    amount: amountPaise,
    currency: 'INR',
    accept_partial: false,
    description,
    reference_id: String(referenceId),
    customer: {
      name: name || undefined,
      contact: `+91${String(mobile).replace(/\D/g, '').slice(-10)}`,
    },
    // The customer is already in WhatsApp with us; Razorpay must not message
    // them as well.
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes,
    expire_by: Math.floor(Date.now() / 1000) + expiresInMinutes * 60,
  });
}

/**
 * A payment link for a fleet quotation (user, 2026-09-29). Unlike a customer's
 * link it may have no mobile — fleets are dealt with by email — and Razorpay
 * sends nothing itself: the quotation email carries the link.
 */
async function createFleetLink({ amountPaise, description, referenceId, name, email, mobile, notes = {}, expireBy }) {
  const contact = String(mobile || '').replace(/\D/g, '').slice(-10);
  return call('/payment_links', 'POST', {
    amount: amountPaise,
    currency: 'INR',
    accept_partial: false,
    description: String(description).slice(0, 2048),
    reference_id: String(referenceId),
    customer: {
      name: name || undefined,
      email: email || undefined,
      contact: contact.length === 10 ? `+91${contact}` : undefined,
    },
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes,
    expire_by: Math.floor(new Date(expireBy).getTime() / 1000),
  });
}

/**
 * Did this webhook really come from Razorpay?
 *
 * Same reasoning as Meta's: the endpoint is a public URL that grants paid
 * subscriptions. Without this, anyone who learns it can activate their own.
 * Razorpay signs the raw body with the webhook secret, so the exact bytes are
 * required — re-serialised JSON produces a different digest.
 */
function verifyWebhook(rawBody, signature) {
  if (!WEBHOOK_SECRET) return 'unset';
  if (!signature) return 'missing';

  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8'))
    .digest('hex');

  const a = Buffer.from(String(signature), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return 'bad';
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'bad';
}

/**
 * An order — what Razorpay Checkout needs to open.
 *
 * Different from a payment link on purpose: a link ends at Razorpay's own page
 * and tells us nothing until a webhook arrives. An order is opened by Checkout
 * inside our page, which hands the browser a success callback — so the money is
 * verified and the subscription activated before the customer is even back in
 * WhatsApp.
 */
async function createOrder({ amountPaise, receipt, notes = {} }) {
  return call('/orders', 'POST', {
    amount: amountPaise,
    currency: 'INR',
    receipt: String(receipt).slice(0, 40),
    notes,
    payment_capture: 1,
  });
}

/**
 * Did this success callback really come from Razorpay?
 *
 * The browser is not to be trusted: anything it posts back could be invented.
 * Razorpay signs "order_id|payment_id" with the KEY SECRET, which only the two
 * of us know, so recomputing it is what separates a real payment from someone
 * calling our verify endpoint with made-up ids.
 */
function verifyCheckout({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac('sha256', SECRET)
    .update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(String(signature), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Look a payment up directly — used when a webhook looks wrong or is missing. */
const getPayment = (id) => call(`/payments/${id}`);
const getLink = (id) => call(`/payment_links/${id}`);
/**
 * Payments made in a window, newest first, 100 at a time (reconciliation,
 * operations module). Read-only. `from`/`to` are Dates.
 */
const listPayments = ({ from, to, skip = 0, count = 100 }) => call(
  `/payments?from=${Math.floor(from.getTime() / 1000)}&to=${Math.floor(to.getTime() / 1000)}&count=${count}&skip=${skip}`);
/** Every payment attempted against an order — the reconciler looks for a captured one. */
const getOrderPayments = (orderId) => call(`/orders/${orderId}/payments`);

module.exports = { createLink, createFleetLink, createOrder, verifyWebhook, verifyCheckout,
                   getPayment, getLink, getOrderPayments, listPayments, configured, isLive, KEY };
