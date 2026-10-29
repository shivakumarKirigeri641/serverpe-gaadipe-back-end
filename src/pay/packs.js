/**
 * src/pay/packs.js — CHECK PACK ORDERS (user, 2026-10-26: "1 vehicle check free ... then pay for checks";
 * migrations 213-215). Three packs, GST included: ₹25 = 5 checks / 30 days (CHECKS5), ₹49 = 12 / 60 days
 * (CHECKS12), ₹99 = 25 / 90 days (CHECKS25). No vehicle is involved.
 *
 *   packPlans()                          -> every active pack, cheapest first, the best value marked
 *   startOrder({ user, channel, code })  -> the payment row, with its checkout_token for /pay/<token>
 *
 * Shared by WhatsApp (flow.js) and the website (siteApi.js). The checkout page asks for the invoice's name and
 * state; an email is optional (nothing is delivered by email). An unpaid pack order from the last hour is reused,
 * so a second tap never opens a second order. Activation and the credits: pay/billing.activate.
 */
const db = require('../db');
const billing = require('./billing');
const razorpay = require('./razorpay');

/* The plans as the admin set them (Settings → Plans: price, checks, days, discount, on/off; user, 2026-10-26:
   "configurable in admin panel"). price_paise is what is charged: the price less any discount, never under ₹1.
   THREE PACKS (migration 215): ₹25 / 5 / 30 days, ₹49 / 12 / 60 days, ₹99 / 25 / 90 days - every active
   'checks' plan, cheapest first; the dearest is marked best value (lowest price per check). */
const shape = (p) => {
  const off = Math.max(0, Number(p.discount_paise) || 0);
  const price = Math.max(100, Number(p.price_paise) - off);
  const checks = Number(p.check_credits) || 5;
  return { ...p, list_price_paise: Number(p.price_paise), price_paise: price, checks,
    days: Number(p.duration_days) || 30, rupees: Math.round(price / 100), per_check_paise: Math.round(price / checks) };
};
async function packPlans() {
  const { rows } = await db.query(`SELECT * FROM plans WHERE kind = 'checks' AND is_active ORDER BY price_paise, id`);
  const out = rows.map(shape);
  const best = out.length > 1 ? out.reduce((a, b) => (b.per_check_paise < a.per_check_paise ? b : a)) : null;
  return out.map((p) => ({ ...p, best: Boolean(best && p.code === best.code) }));
}
/** One pack by its code, or the cheapest when none is named. */
async function packPlan(code = null) {
  const all = await packPlans();
  return (code ? all.find((p) => p.code === String(code).toUpperCase()) : all[0]) || null;
}
/** For the customer-facing lists: code, checks, rupees, days, best. */
const brief = (p) => ({ code: p.code, checks: p.checks, price_paise: p.price_paise, rupees: p.rupees, days: p.days, best: p.best });

/* CHECKS THAT COME WITH A REPORT (user, 2026-10-29: "go ahead" - ₹11 one report only, ₹19 keeps +5; migration 222).
   A report plan's own check_credits; not set → checks_per_report_bonus. reportBonus(): the cheapest active report
   that adds checks, for the texts ("The ₹19 report with alerts also adds 5 checks"), or null when none does. */
async function reportChecks(plan) {
  if (plan?.check_credits != null) return Math.max(0, Number(plan.check_credits) || 0);
  return require('../util/settings').num('checks_per_report_bonus', 5);
}
async function reportBonus() {
  const { rows } = await db.query(`SELECT * FROM plans WHERE kind = 'report' AND is_active ORDER BY price_paise, id`);
  for (const p of rows) {
    const checks = await reportChecks(p);
    if (checks > 0) return { code: p.code, checks, rupees: Math.round(Math.max(100, Number(p.price_paise) - (Number(p.discount_paise) || 0)) / 100) };
  }
  return null;
}

class PackError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function startOrder({ user, channel = 'whatsapp', code = null }) {
  const plan = await packPlan(code);
  if (!plan || !razorpay.configured() || !(await require('../util/flags').on('payments'))) {
    console.error('[pack] cannot sell a pack %s: plan=%s razorpay=%s', code || '(cheapest)', Boolean(plan), razorpay.configured());
    throw new PackError('unavailable', 'Payment is not available right now. Please try again shortly.');
  }
  const checks = plan.checks;
  // The owner's own test purchases (razorpay.isTestBuyer): Razorpay TEST keys, ₹0 in the books.
  const test = await razorpay.isTestBuyer(user).catch(() => false);

  let row = await db.one(
    `SELECT * FROM payments
      WHERE user_id = $1 AND plan_id = $2 AND status = 'created' AND checkout_token IS NOT NULL
        AND coalesce((raw->>'test_mode')::boolean, false) = $3
        -- The same price and checks: a pack the admin has changed since is a new order.
        AND amount_paise = $4 AND (raw->>'checks')::int = $5
        AND created_at > now() - interval '1 hour'
      ORDER BY id DESC LIMIT 1`, [user.id, plan.id, test, plan.price_paise, checks]);

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

module.exports = { startOrder, packPlan, packPlans, brief, reportChecks, reportBonus, PackError };
