/**
 * src/pay/billing.js
 * ---------------------------------------------------------------------------
 * What happens because money moved.
 *
 * Kept apart from the gateway on purpose: razorpay.js knows how to talk to
 * Razorpay, this file knows what a payment MEANS — a subscription starts, a
 * watch begins, a partner earns, an invoice is due. Swapping gateways one day
 * should not touch any of that.
 *
 * Everything here is idempotent, because a webhook is delivered more than once
 * whenever Razorpay is unsure we heard it. Activating twice would give away a
 * free month and pay a partner twice for one sale.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const settings = require('../util/settings');

const DAY = 24 * 60 * 60 * 1000;

/** The plan a purchase is against. One active watch plan today. */
const watchPlan = () => db.one(
  `SELECT * FROM plans WHERE code = 'WATCH28' AND is_active LIMIT 1`);

/**
 * What this customer owes for this vehicle right now.
 *
 * First payment and renewal are different prices, and "first" is a property of
 * the VEHICLE, not of the customer: someone renewing one car and adding another
 * pays ₹29 for the first and ₹49 for the second, on the same day.
 */
async function priceFor(userId, vehicleId) {
  const plan = await watchPlan();
  const prior = await db.one(
    `SELECT 1 FROM subscriptions
      WHERE user_id = $1 AND vehicle_id = $2
      LIMIT 1`, [userId, vehicleId]);

  const renewal = Boolean(prior);
  const paise = renewal
    ? (plan.renewal_paise ?? plan.price_paise)
    : plan.price_paise;

  return { plan, paise, kind: renewal ? 'renewal' : 'first' };
}

/** Record a payment we are about to ask for. Nothing is active yet. */
async function createPending({ userId, planId, amountPaise, vehicleId }) {
  const { rows } = await db.query(
    `INSERT INTO payments (user_id, plan_id, amount_paise, status, gateway, raw)
          VALUES ($1, $2, $3, 'created', 'razorpay', $4)
       RETURNING *`,
    [userId, planId, amountPaise, JSON.stringify({ vehicle_id: vehicleId })]);
  return rows[0];
}

/**
 * Money arrived. Start the subscription, start watching, log the commission.
 *
 * Returns { activated, subscription, endsOn } — `activated` is false when this
 * payment was already processed, which is a normal outcome, not an error.
 */
async function activate({ paymentRowId, razorpayPaymentId, orderId, raw }) {
  return db.tx(async (c) => {
    // Lock the row: two webhook deliveries can arrive at the same instant.
    const pay = (await c.query(
      `SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentRowId])).rows[0];
    if (!pay) return { activated: false, reason: 'unknown_payment' };
    if (pay.status === 'paid') return { activated: false, reason: 'already_paid' };

    const vehicleId = pay.raw?.vehicle_id || null;
    const plan = (await c.query(`SELECT * FROM plans WHERE id = $1`, [pay.plan_id])).rows[0];
    const days = plan?.duration_days || 28;

    // ONE SUBSCRIPTION PER VEHICLE. Looked up by vehicle, not by customer:
    // extending a customer-wide subscription every time they bought a vehicle
    // silently handed their earlier vehicles a free month each.
    const existing = vehicleId ? (await c.query(
      `SELECT * FROM subscriptions
        WHERE user_id = $1 AND vehicle_id = $2 AND is_active
        ORDER BY ends_on DESC LIMIT 1`, [pay.user_id, vehicleId])).rows[0] : null;

    // Renewing early adds to what they already own rather than resetting from
    // today, so nobody is punished for paying before the last day.
    const from = existing && new Date(existing.ends_on) > new Date()
      ? new Date(existing.ends_on) : new Date();
    const endsOn = new Date(from.getTime() + days * DAY);

    let sub;
    if (existing) {
      sub = (await c.query(
        `UPDATE subscriptions
            SET ends_on = $2, renewal_count = renewal_count + 1,
                is_active = true, modified_at = now()
          WHERE id = $1 RETURNING *`,
        [existing.id, endsOn.toISOString().slice(0, 10)])).rows[0];
    } else {
      sub = (await c.query(
        `INSERT INTO subscriptions (user_id, plan_id, vehicle_id, vehicle_count,
                                    price_paise, ends_on)
              VALUES ($1, $2, $3, 1, $4, $5) RETURNING *`,
        [pay.user_id, pay.plan_id, vehicleId, pay.amount_paise,
         endsOn.toISOString().slice(0, 10)])).rows[0];
    }

    await c.query(
      `UPDATE payments SET status = 'paid', payment_id = $2, order_id = $3,
              subscription_id = $4, paid_at = now(),
              raw = COALESCE(raw, '{}'::jsonb) || $5::jsonb
        WHERE id = $1`,
      [pay.id, razorpayPaymentId, orderId || null, sub.id, JSON.stringify({ gateway: raw || {} })]);

    // The watch: a paid vehicle is checked until the subscription ends, not
    // until some separate date that could drift out of step with it.
    if (vehicleId) {
      const checkEvery = await settings.num('watch_check_interval_minutes', 24 * 60);
      await c.query(
        `INSERT INTO watches (user_id, vehicle_id, subscription_id, expires_on, expires_at,
                              challan_next_check_at, rc_next_check_at, fastag_next_check_at,
                              challan_interval_hours, rc_interval_hours, fastag_interval_hours)
              VALUES ($1, $2, $3, $4, $5,
                      now() + ($6 || ' minutes')::interval,
                      now() + ($6 || ' minutes')::interval,
                      now() + ($6 || ' minutes')::interval,
                      $7, $7, $7)
         ON CONFLICT (user_id, vehicle_id) DO UPDATE
                SET is_active = true, subscription_id = EXCLUDED.subscription_id,
                    expires_on = EXCLUDED.expires_on, expires_at = EXCLUDED.expires_at,
                    modified_at = now()`,
        [pay.user_id, vehicleId, sub.id, endsOn.toISOString().slice(0, 10),
         endsOn.toISOString(), String(checkEvery), Math.max(1, Math.round(checkEvery / 60))]);
    }

    await accrueCommission(c, pay, sub);

    await c.query(
      `INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'payment_paid', $3)`,
      [pay.user_id, vehicleId,
       JSON.stringify({ payment_id: razorpayPaymentId, amount_paise: pay.amount_paise,
                        subscription_id: sub.id, ends_on: endsOn.toISOString().slice(0, 10) })]);

    return { activated: true, subscription: sub, endsOn, payment: pay, vehicleId };
  });
}

/**
 * The partner's share.
 *
 * ₹5 per vehicle on a vehicle's first payment, ₹3 on every renewal. Held
 * against the payment, so it can never be earned twice and is reversed by name
 * if the payment is refunded.
 */
async function accrueCommission(c, pay, sub) {
  const referral = (await c.query(
    `SELECT r.id, r.partner_id FROM partner_referrals r
      WHERE r.user_id = $1 LIMIT 1`, [pay.user_id])).rows[0];
  if (!referral) return;

  // A subscription covers exactly one vehicle, so "per vehicle" and "per
  // payment" are the same number here — Rs.5 on that vehicle's first payment,
  // Rs.3 on each renewal of it.
  const first = sub.renewal_count === 0;
  const key = first ? 'partner_first_paise_per_vehicle' : 'partner_renewal_paise_per_vehicle';
  const per = await settings.num(key, first ? 500 : 300);
  const vehicles = 1;

  await c.query(
    `INSERT INTO partner_commissions
       (partner_id, referral_id, payment_id, kind, base_paise, amount_paise,
        vehicle_count, per_vehicle_paise, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'accrued')
     ON CONFLICT (payment_id) DO NOTHING`,
    [referral.partner_id, referral.id, pay.id, first ? 'first' : 'renewal',
     pay.amount_paise, per * vehicles, vehicles, per]);
}

/**
 * Money went back. Stop watching and reverse the commission.
 *
 * A refunded customer who keeps their subscription, and a partner who keeps
 * commission on money we returned, are both silent errors: nothing in the
 * system disagrees with itself, and nobody finds out until the accounts do.
 */
async function refund({ razorpayPaymentId, refundId, raw }) {
  return db.tx(async (c) => {
    const pay = (await c.query(
      `SELECT * FROM payments WHERE payment_id = $1 FOR UPDATE`, [razorpayPaymentId])).rows[0];
    if (!pay) return { reversed: false, reason: 'unknown_payment' };
    if (pay.status === 'refunded') return { reversed: false, reason: 'already_refunded' };

    await c.query(
      `UPDATE payments SET status = 'refunded', refund_id = $2, refunded_at = now(),
              raw = COALESCE(raw, '{}'::jsonb) || $3::jsonb
        WHERE id = $1`,
      [pay.id, refundId || null, JSON.stringify({ refund: raw || {} })]);

    if (pay.subscription_id) {
      await c.query(
        `UPDATE subscriptions SET is_active = false, cancelled_at = now(), modified_at = now()
          WHERE id = $1`, [pay.subscription_id]);
      await c.query(
        `UPDATE watches SET is_active = false, modified_at = now()
          WHERE subscription_id = $1`, [pay.subscription_id]);
    }

    await c.query(
      `UPDATE partner_commissions
          SET status = 'clawed_back', clawback_reason = 'payment refunded'
        WHERE payment_id = $1 AND status IN ('accrued', 'paid')`, [pay.id]);

    await c.query(
      `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'payment_refunded', $2)`,
      [pay.user_id, JSON.stringify({ payment_id: razorpayPaymentId, refund_id: refundId })]);

    return { reversed: true, payment: pay };
  });
}

module.exports = { watchPlan, priceFor, createPending, activate, refund };
