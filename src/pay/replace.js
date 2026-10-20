/**
 * src/pay/replace.js — REPLACE VEHICLE (user, 2026-10-13: "small fee 9 + GST for
 * replace vehicle rather than move vehicle, because most people won't understand").
 *
 * Paid monitoring that is running moves from vehicle A to vehicle B for ₹11 including
 * GST — ₹9.32 + ₹1.68 (plan REPLACE9; ₹10.62 from migration 163 until 172, 2026-10-14):
 *   - the subscription keeps its end date — the days left carry over, none added
 *   - A comes off the customer's list and every alert for it stops
 *     (vehicle/remove.js rules); A's report and invoice stay
 *   - B is watched from now until that end date; its full report is NOT included
 *   - once per purchase (the report or renewal that started this period), within
 *     replace_window_days of it (7; 0 = any time while it runs)
 * The customer types B; it is looked up first (a check, under the usual daily
 * limits), so they see what they are paying for. A mistyped B is theirs (user,
 * 2026-10-13) — the confirmation shows its make and model before paying.
 *
 * The move itself happens when the money arrives (pay/billing.js activate), in
 * the same transaction as the payment.
 */

const db = require('../db');
const settings = require('../util/settings');

const plan = () => db.one(`SELECT * FROM plans WHERE code = 'REPLACE9' AND is_active LIMIT 1`);
const rupees = (paise) => `₹${(Number(paise || 0) / 100).toFixed(Number(paise || 0) % 100 ? 2 : 0)}`;

/**
 * Can this vehicle's monitoring be replaced right now?
 * { ok, sub, vehicle_id, reg_no, ends_on, price_paise, until } or { ok: false, reason, message }.
 */
async function eligible(userId, fromReg) {
  if (!(await settings.bool('replace_enabled', true))) return { ok: false, reason: 'off', message: 'Replacing a vehicle is not available right now.' };
  const p = await plan();
  if (!p) return { ok: false, reason: 'off', message: 'Replacing a vehicle is not available right now.' };
  const row = await db.one(
    `SELECT s.*, v.reg_no, v.id AS vid
       FROM user_vehicles uv
       JOIN vehicles v ON v.id = uv.vehicle_id
       JOIN watches w ON w.user_id = uv.user_id AND w.vehicle_id = v.id AND w.is_active AND w.subscription_id IS NOT NULL
       JOIN subscriptions s ON s.id = w.subscription_id AND s.is_active AND s.ends_on >= CURRENT_DATE
      WHERE uv.user_id = $1 AND v.reg_no = $2 AND uv.hidden_at IS NULL
      LIMIT 1`, [userId, fromReg]);
  if (!row) return { ok: false, reason: 'not_paid', message: `Only a vehicle with paid monitoring that is still running can be replaced — *${fromReg}* has none.` };

  // The purchase that started this period: the latest paid report or renewal on this subscription.
  const bought = await db.one(
    `SELECT max(p.paid_at) AS at FROM payments p JOIN plans pl ON pl.id = p.plan_id
      WHERE p.subscription_id = $1 AND p.status = 'paid' AND pl.kind <> 'replace'`, [row.id]);
  const since = bought?.at ? new Date(bought.at) : new Date(row.created_at);
  const already = await db.one(
    `SELECT 1 FROM payments p JOIN plans pl ON pl.id = p.plan_id
      WHERE pl.kind = 'replace' AND p.status = 'paid' AND p.raw->'replace'->>'subscription_id' = $1::text
        AND p.paid_at >= $2 LIMIT 1`, [String(row.id), since]);
  if (already) return { ok: false, reason: 'used', message: 'This purchase has already been used to replace a vehicle once.' };
  const windowDays = await settings.num('replace_window_days', 7);
  const until = windowDays > 0 ? new Date(since.getTime() + windowDays * 86400e3) : null;
  if (until && until < new Date()) {
    return { ok: false, reason: 'late', message: `A vehicle can be replaced within ${windowDays} days of buying its report or renewal — that time has passed for *${fromReg}*.` };
  }
  return { ok: true, sub: row, vehicle_id: Number(row.vid), reg_no: row.reg_no, ends_on: row.ends_on,
           price_paise: Number(p.price_paise), plan: p, until };
}

/**
 * Look up the new vehicle the way any check does — blocks, private vehicles, the
 * daily limits, the record stored — so its make and model can be shown before paying.
 * { ok, reg_no, vehicle_id, maker, model } or { ok: false, message }.
 */
async function lookupNew(userId, mobile, toReg) {
  if (await require('../admin/blocks').isBlocked('vehicle', toReg).catch(() => false)
      || await require('../owners/verify').hiddenFrom(mobile, toReg).catch(() => false)) {
    return { ok: false, message: `The owner of *${toReg}* keeps its details private, so it cannot be monitored.` };
  }
  const quota = require('../util/quota');
  const q = await quota.check(userId, toReg);
  if (!q.allowed) return { ok: false, message: 'You have reached your checks for now. Please try again later.' };
  let data;
  try { data = await require('../vehicle/gateway').full(toReg, await require('../vehicle/rcBackup').freeOpts()); }
  catch (e) { data = null; }
  await quota.record(userId, toReg, { repeat: q.repeat, found: data?.success === true });
  if (!data || data.success !== true || !(data.rc && (data.rc.maker || data.rc.model || data.rc.vehicle_class))) {
    return { ok: false, message: data?.error === 'vehicle_not_found'
      ? `I could not find any vehicle record for *${toReg}*. Please check the number.`
      : 'Our vehicle records source is not answering right now. Please try again in a little while.' };
  }
  await require('../vehicle/store').record(userId, data).catch(() => {});
  const v = await db.one(`SELECT id, maker, model FROM vehicles WHERE reg_no = $1`, [toReg]);
  if (!v) return { ok: false, message: 'Please try again in a minute.' };
  return { ok: true, reg_no: toReg, vehicle_id: Number(v.id), maker: v.maker, model: v.model };
}

/**
 * Everything before paying: A can be replaced, B is a real, different vehicle not
 * already monitored. { ok, from, to, ends_on, price_paise } or { ok: false, message }.
 */
async function prepare(userId, mobile, fromReg, toRaw, { lookup = true } = {}) {
  const parsed = require('../util/plate').parse(toRaw);
  if (!parsed.ok) return { ok: false, message: parsed.error };
  const toReg = parsed.regNo;
  if (toReg === fromReg) return { ok: false, message: 'That is the same vehicle. Please send the number of the new one.' };
  const e = await eligible(userId, fromReg);
  if (!e.ok) return e;
  const watched = await db.one(
    `SELECT 1 FROM watches w JOIN vehicles v ON v.id = w.vehicle_id
      WHERE w.user_id = $1 AND v.reg_no = $2 AND w.is_active LIMIT 1`, [userId, toReg]);
  if (watched) return { ok: false, message: `*${toReg}* is already being monitored for you — choose another vehicle.` };
  // Paying after the confirmation: the record just looked up is used, not fetched again.
  let to;
  if (lookup) to = await lookupNew(userId, mobile, toReg);
  else {
    const v = await db.one(`SELECT id, maker, model FROM vehicles WHERE reg_no = $1 AND (maker IS NOT NULL OR model IS NOT NULL)`, [toReg]);
    to = v ? { ok: true, reg_no: toReg, vehicle_id: Number(v.id), maker: v.maker, model: v.model }
      : { ok: false, message: `Please check *${toReg}* first.` };
  }
  if (!to.ok) return to;
  return { ok: true, from: { reg_no: fromReg, vehicle_id: e.vehicle_id }, to, ends_on: e.ends_on,
           price_paise: e.price_paise, subscription_id: String(e.sub.id), plan: e.plan };
}

/**
 * The order (Razorpay) and the checkout link. An unpaid one for the same move in
 * the last hour is reused. { ok, row } or { ok: false, message }.
 */
async function order(userId, mobile, prep, { channel = 'whatsapp', test = false } = {}) {
  const razorpay = require('./razorpay');
  if (!razorpay.configured() || !(await require('../util/flags').on('payments'))) {
    return { ok: false, message: 'Payments are not available right now. Please try again shortly.' };
  }
  let row = await db.one(
    `SELECT * FROM payments
      WHERE user_id = $1 AND plan_id = $2 AND status = 'created' AND checkout_token IS NOT NULL
        AND (raw->>'vehicle_id')::bigint = $3 AND raw->'replace'->>'from_reg' = $4
        AND coalesce((raw->>'test_mode')::boolean, false) = $5
        AND created_at > now() - interval '1 hour'
      ORDER BY id DESC LIMIT 1`, [userId, prep.plan.id, prep.to.vehicle_id, prep.from.reg_no, test]);
  if (!row) {
    const pending = await require('./billing').createPending({
      userId, planId: prep.plan.id, amountPaise: prep.price_paise, vehicleId: prep.to.vehicle_id, channel,
    });
    let o;
    try {
      o = await razorpay.createOrder({
        amountPaise: prep.price_paise, receipt: `gp-${pending.id}`,
        notes: { reference_id: `gp-${pending.id}`, reg_no: prep.to.reg_no, replaces: prep.from.reg_no,
                 mobile, plan: prep.plan.code, channel, ...(test ? { test_mode: 'owner' } : {}) },
        test,
      });
      if (!o?.id) throw new Error('no order id returned');
    } catch (e) {
      console.error('[replace] order creation failed:', e.message);
      return { ok: false, message: 'We could not start the payment just now. Please try again in a minute.' };
    }
    const token = require('crypto').randomBytes(16).toString('hex');
    row = (await db.query(
      `UPDATE payments SET order_id = $2, checkout_token = $3, raw = COALESCE(raw, '{}'::jsonb) || $4::jsonb
        WHERE id = $1 RETURNING *`,
      [pending.id, o.id, token, JSON.stringify({
        order_id: o.id, channel, ...(test ? { test_mode: true } : {}),
        replace: { from_reg: prep.from.reg_no, from_vehicle_id: String(prep.from.vehicle_id),
                   to_reg: prep.to.reg_no, subscription_id: prep.subscription_id },
      })])).rows[0];
  }
  await db.query(`INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'purchase_consent', $3)`,
    [userId, prep.to.vehicle_id, JSON.stringify({ mobile, reg_no: prep.to.reg_no, replaces: prep.from.reg_no,
      amount_paise: row.amount_paise, plan: prep.plan.code, channel, documents: ['terms', 'refund', 'privacy'],
      payment_row: String(row.id), at: new Date().toISOString() })]);
  return { ok: true, row };
}

/**
 * THE MOVE, inside billing.activate's transaction (client `c`, payment `pay`
 * locked). Returns the subscription and its end date, or throws to roll the
 * payment back to "not activated" — never half done.
 */
async function apply(c, pay) {
  const r = pay.raw?.replace || {};
  const subId = r.subscription_id;
  const toId = pay.raw?.vehicle_id;
  const fromId = r.from_vehicle_id;
  // ends_on as written (YYYY-MM-DD) — a Date would shift it a day through the time zone.
  const sub = (await c.query(`SELECT *, ends_on::text AS ends_day FROM subscriptions WHERE id = $1 FOR UPDATE`, [subId])).rows[0];
  if (!sub || !toId || !fromId) throw new Error(`replace payment ${pay.id}: subscription or vehicles missing`);
  // The subscription now covers B, to the same end date.
  await c.query(`UPDATE subscriptions SET vehicle_id = $2, is_active = true, modified_at = now() WHERE id = $1`, [sub.id, toId]);
  // A: off the list, its watch and any pause ended (vehicle/remove.js rules).
  await c.query(`UPDATE watches SET is_active = false, modified_at = now() WHERE user_id = $1 AND vehicle_id = $2 AND is_active`, [pay.user_id, fromId]);
  await c.query(`UPDATE user_vehicles SET hidden_at = now(), hidden_count = hidden_count + 1 WHERE user_id = $1 AND vehicle_id = $2 AND hidden_at IS NULL`, [pay.user_id, fromId]);
  await c.query(`DELETE FROM alert_snoozes WHERE user_id = $1 AND vehicle_id = $2`, [pay.user_id, fromId]);
  // B: on the list, watched until the same end date — first look straight away.
  await c.query(
    `INSERT INTO user_vehicles (user_id, vehicle_id) VALUES ($1, $2)
     ON CONFLICT (user_id, vehicle_id) DO UPDATE SET hidden_at = NULL`, [pay.user_id, toId]);
  const endsAt = new Date(`${sub.ends_day}T18:29:59Z`);   // the end day's last second, India's time
  await c.query(
    `INSERT INTO watches (user_id, vehicle_id, subscription_id, expires_on, expires_at,
                          challan_next_check_at, rc_next_check_at, fastag_next_check_at,
                          challan_interval_hours, rc_interval_hours, fastag_interval_hours)
          VALUES ($1, $2, $3, $4, $5, now(), now(), now(), 24, 24, 24)
     ON CONFLICT (user_id, vehicle_id) DO UPDATE
            SET is_active = true, subscription_id = EXCLUDED.subscription_id,
                expires_on = EXCLUDED.expires_on, expires_at = EXCLUDED.expires_at,
                challan_next_check_at = now(), rc_next_check_at = now(), modified_at = now()`,
    [pay.user_id, toId, sub.id, sub.ends_day, endsAt.toISOString()]);
  await c.query(`INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'vehicle_replaced', $3)`,
    [pay.user_id, toId, JSON.stringify({ from_reg: r.from_reg, to_reg: r.to_reg, subscription_id: String(sub.id), payment_row: String(pay.id) })]);
  return { sub: { ...sub, vehicle_id: toId }, endsOn: new Date(sub.ends_on) };
}

module.exports = { plan, eligible, lookupNew, prepare, order, apply, rupees };
