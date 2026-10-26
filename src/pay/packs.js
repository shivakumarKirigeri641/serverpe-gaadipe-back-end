/**
 * src/pay/packs.js — A CHECK PACK ORDER (user, 2026-10-26: "1 vehicle check free ... then pay for checks";
 * migration 213; ₹25 since migration 214). CHECKS5: ₹25 including GST for 5 vehicle checks, valid 30 days. No vehicle is involved.
 *
 *   startOrder({ user, channel }) -> the payment row, with its checkout_token for /pay/<token>
 *
 * Shared by WhatsApp (flow.js) and the website (siteApi.js). The checkout page asks for the invoice's name and
 * state; an email is optional (nothing is delivered by email). An unpaid pack order from the last hour is reused,
 * so a second tap never opens a second order. Activation and the credits: pay/billing.activate.
 */
const db = require('../db');
const billing = require('./billing');
const razorpay = require('./razorpay');
const settings = require('../util/settings');

/* The plan as the admin set it (Settings → Plans: price, days, discount, on/off; user, 2026-10-26: "configurable in
   admin panel"). price_paise is what is charged: the price less any discount, never under ₹1. */
async function packPlan() {
  const p = await db.one(`SELECT * FROM plans WHERE code = 'CHECKS5' AND is_active LIMIT 1`);
  if (!p) return null;
  const off = Math.max(0, Number(p.discount_paise) || 0);
  return { ...p, list_price_paise: Number(p.price_paise), price_paise: Math.max(100, Number(p.price_paise) - off) };
}

class PackError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function startOrder({ user, channel = 'whatsapp' }) {
  const plan = await packPlan();
  if (!plan || !razorpay.configured() || !(await require('../util/flags').on('payments'))) {
    console.error('[pack] cannot sell a pack: plan=%s razorpay=%s', Boolean(plan), razorpay.configured());
    throw new PackError('unavailable', 'Payment is not available right now. Please try again shortly.');
  }
  const checks = await settings.num('check_pack_checks', 5);
  // The owner's own test purchases (razorpay.isTestBuyer): Razorpay TEST keys, ₹0 in the books.
  const test = await razorpay.isTestBuyer(user).catch(() => false);

  let row = await db.one(
    `SELECT * FROM payments
      WHERE user_id = $1 AND plan_id = $2 AND status = 'created' AND checkout_token IS NOT NULL
        AND coalesce((raw->>'test_mode')::boolean, false) = $3
        AND created_at > now() - interval '1 hour'
      ORDER BY id DESC LIMIT 1`, [user.id, plan.id, test]);

  if (!row) {
    const pending = await billing.createPending({ userId: user.id, planId: plan.id, amountPaise: plan.price_paise,
      vehicleId: null, channel });
    let order;
    try {
      order = await razorpay.createOrder({
        amountPaise: plan.price_paise,
        receipt: `gp-${pending.id}`,
        // reference_id is what the webhook matches on.
        notes: { reference_id: `gp-${pending.id}`, mobile: user.mobile, plan: plan.code, channel,
                 ...(test ? { test_mode: 'owner' } : {}) },
        test,
      });
      if (!order?.id) throw new Error('no order id returned');
    } catch (e) {
      console.error('[pack] order creation failed:', e.message);
      throw new PackError('gateway', 'Sorry, I could not start the payment just now. Please try again in a minute.');
    }
    const token = require('crypto').randomBytes(16).toString('hex');
    row = (await db.query(
      `UPDATE payments SET order_id = $2, checkout_token = $3, raw = COALESCE(raw,'{}'::jsonb) || $4::jsonb
        WHERE id = $1 RETURNING *`,
      [pending.id, order.id, token, JSON.stringify({ order_id: order.id, checks, ...(test ? { test_mode: true } : {}) })])).rows[0];
    if (test) console.log('[pack] TEST-mode order %s for the owner (payment row %d)', order.id, pending.id);
  }

  // What they agreed to by paying: the same documents as a report purchase.
  await db.query(
    `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'purchase_consent', $2)`,
    [user.id, JSON.stringify({ mobile: user.mobile, amount_paise: row.amount_paise, plan: plan.code, checks,
      channel, documents: ['terms', 'refund', 'privacy'], payment_row: String(row.id), at: new Date().toISOString() })]);
  return row;
}

module.exports = { startOrder, packPlan, PackError };
