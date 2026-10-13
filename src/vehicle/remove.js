/**
 * src/vehicle/remove.js — REMOVE FROM MY VEHICLES, one rule for the website's bin
 * button (2026-10-08) and WhatsApp's "Remove a vehicle" (user, 2026-10-13).
 *
 * For the customer the vehicle is gone; nothing is deleted. Their link to it is
 * marked hidden (migration 140) and every alert stops: the watches for it are
 * switched off, so no status update, change alert, expiry warning (expiryWatch
 * skips hidden links) or renewal reminder (jobs/renewal.js) goes out for it.
 * Reports and invoices stay downloadable — they were paid for.
 *
 * ONLY THIS CUSTOMER'S LINK. The vehicle itself, and every other customer's link
 * to it, is untouched: anyone can check the number tomorrow, and this customer
 * too — it then comes back as a fresh entry (vehicle/store.js linkUserVehicle).
 */

const db = require('../db');

/** What removing it would end, for the confirmation: { reg_no, vehicle_id, watched_until, report_until, paid } or null. */
async function describe(userId, regNo) {
  return db.one(
    `SELECT v.reg_no, v.id AS vehicle_id,
            (SELECT max(coalesce(w.expires_at, sb.ends_on::timestamptz)) FROM watches w
               LEFT JOIN subscriptions sb ON sb.id = w.subscription_id
              WHERE w.user_id = uv.user_id AND w.vehicle_id = v.id AND w.is_active) AS watched_until,
            EXISTS (SELECT 1 FROM watches w WHERE w.user_id = uv.user_id AND w.vehicle_id = v.id
                     AND w.is_active AND w.subscription_id IS NOT NULL) AS paid,
            (SELECT max(r.valid_until) FROM vehicle_reports r
              WHERE r.user_id = uv.user_id AND r.reg_no = v.reg_no AND r.valid_until > now()) AS report_until
       FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
      WHERE uv.user_id = $1 AND v.reg_no = $2 AND uv.hidden_at IS NULL`, [userId, regNo]);
}

/** Remove it from this customer's list. { ok, vehicle_id, alerts_stopped } or { ok: false } when not in their list. */
async function removeForUser(userId, regNo, { channel = 'web' } = {}) {
  const { rows } = await db.query(
    `UPDATE user_vehicles uv SET hidden_at = now(), hidden_count = uv.hidden_count + 1
       FROM vehicles v
      WHERE v.id = uv.vehicle_id AND uv.user_id = $1 AND v.reg_no = $2 AND uv.hidden_at IS NULL
      RETURNING uv.vehicle_id`, [userId, regNo]);
  if (!rows.length) return { ok: false };
  const vehicleId = rows[0].vehicle_id;
  const stopped = await db.query(
    `UPDATE watches SET is_active = false, modified_at = now()
      WHERE user_id = $1 AND vehicle_id = $2 AND is_active`, [userId, vehicleId]);
  // A pause on it means nothing any more.
  await db.query(`DELETE FROM alert_snoozes WHERE user_id = $1 AND vehicle_id = $2`, [userId, vehicleId]).catch(() => {});
  await db.query(`INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'vehicle_removed', $3)`,
    [userId, vehicleId, JSON.stringify({ reg_no: regNo, alerts_stopped: stopped.rowCount, channel })]);
  return { ok: true, vehicle_id: vehicleId, alerts_stopped: stopped.rowCount };
}

module.exports = { describe, removeForUser };
