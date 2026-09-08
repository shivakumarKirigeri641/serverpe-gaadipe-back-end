/**
 * src/vehicle/store.js
 * ---------------------------------------------------------------------------
 * Remember vehicles and who looked at them.
 *
 * The gateway already caches upstream responses in memory, so this is not a
 * second cache — it is the record. Two different things need it:
 *
 *   * "Do I already know this person's vehicle?" — answered from the database
 *     in one query, before any network call, which is what makes the bot feel
 *     instant on a second visit.
 *
 *   * The denormalised expiry columns on `vehicles`. Asking "whose insurance
 *     lapses this week" must not mean opening ten thousand JSON snapshots.
 *
 * What is never stored in the display columns: owner name, chassis and engine.
 * The raw snapshot keeps the whole response for re-deriving mappings later, but
 * nothing that must not be shown is lifted into a column something might
 * casually render.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');

const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** Find or create the person behind a mobile number. */
async function upsertUser(mobile, { name, waId } = {}) {
  const { rows } = await db.query(
    `INSERT INTO users (mobile, wa_profile_name, wa_id, signup_channel)
          VALUES ($1, $2, $3, 'whatsapp')
     ON CONFLICT (mobile) DO UPDATE
            SET last_seen_at     = now(),
                modified_at      = now(),
                wa_profile_name  = COALESCE(EXCLUDED.wa_profile_name, users.wa_profile_name),
                wa_id            = COALESCE(EXCLUDED.wa_id, users.wa_id)
      RETURNING *`,
    [mobile, name || null, waId || null]);
  return rows[0];
}

/** Record the vehicle and the expiry dates worth querying. */
async function upsertVehicle(regNo, rc = {}) {
  const { rows } = await db.query(
    `INSERT INTO vehicles
       (reg_no, maker, model, fuel, vehicle_class, reg_date,
        insurance_upto, pucc_upto, fitness_upto, tax_upto, permit_upto,
        owner_serial, financer, blacklist_status, rc_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (reg_no) DO UPDATE SET
        maker = COALESCE(EXCLUDED.maker, vehicles.maker),
        model = COALESCE(EXCLUDED.model, vehicles.model),
        fuel  = COALESCE(EXCLUDED.fuel,  vehicles.fuel),
        vehicle_class = COALESCE(EXCLUDED.vehicle_class, vehicles.vehicle_class),
        reg_date       = COALESCE(EXCLUDED.reg_date, vehicles.reg_date),
        insurance_upto = EXCLUDED.insurance_upto,
        pucc_upto      = EXCLUDED.pucc_upto,
        fitness_upto   = EXCLUDED.fitness_upto,
        tax_upto       = EXCLUDED.tax_upto,
        permit_upto    = EXCLUDED.permit_upto,
        owner_serial   = COALESCE(EXCLUDED.owner_serial, vehicles.owner_serial),
        financer       = COALESCE(EXCLUDED.financer, vehicles.financer),
        blacklist_status = COALESCE(EXCLUDED.blacklist_status, vehicles.blacklist_status),
        rc_status      = COALESCE(EXCLUDED.rc_status, vehicles.rc_status),
        last_seen_at   = now()
     RETURNING *`,
    [regNo, rc.maker || null, rc.model || null, rc.fuel || null, rc.vehicle_class || null,
     date(rc.reg_date), date(rc.insurance_upto), date(rc.pucc_upto), date(rc.fitness_upto),
     date(rc.tax_upto), date(rc.permit_upto), rc.owner_serial || null, rc.financer || null,
     rc.blacklist_status || null, rc.status || null]);
  return rows[0];
}

/** Keep the whole response so a wrong mapping can be re-derived for free. */
async function saveSnapshot(vehicleId, dataset, data, { source, ttlMinutes = 60 * 24 } = {}) {
  await db.query(
    `INSERT INTO vehicle_snapshots (vehicle_id, dataset, data, raw, source, expires_at)
          VALUES ($1, $2, $3, $3, $4, now() + ($5 || ' minutes')::interval)
     ON CONFLICT (vehicle_id, dataset) DO UPDATE
            SET data = EXCLUDED.data, raw = EXCLUDED.raw, source = EXCLUDED.source,
                fetched_at = now(), expires_at = EXCLUDED.expires_at`,
    [vehicleId, dataset, JSON.stringify(data ?? {}), source || null, String(ttlMinutes)]);
}

/** Link a person to a vehicle they looked at, and count the look. */
async function linkUserVehicle(userId, vehicleId, relation = 'checked') {
  await db.query(
    `INSERT INTO user_vehicles (user_id, vehicle_id, relation)
          VALUES ($1, $2, $3)
     ON CONFLICT (user_id, vehicle_id) DO UPDATE
            SET check_count = user_vehicles.check_count + 1,
                last_checked_at = now(),
                -- A stated relation is an upgrade; 'checked' never overwrites
                -- 'owned' just because they looked again.
                relation = CASE WHEN EXCLUDED.relation = 'checked'
                                THEN user_vehicles.relation ELSE EXCLUDED.relation END`,
    [userId, vehicleId, relation]);
}

/**
 * Everything this person is currently watching. Empty for someone who has only
 * ever run free checks — which is the difference the bot needs to know about.
 */
async function watchedBy(userId) {
  const { rows } = await db.query(
    `SELECT w.id, w.expires_on, w.is_active, v.reg_no, v.maker, v.model,
            v.insurance_upto, v.pucc_upto, v.fitness_upto, v.tax_upto, v.permit_upto
       FROM watches w
       JOIN vehicles v ON v.id = w.vehicle_id
      WHERE w.user_id = $1 AND w.is_active
      ORDER BY w.created_at`, [userId]);
  return rows;
}

/** Vehicles this person has checked before, most recent first. */
async function checkedBy(userId, limit = 5) {
  const { rows } = await db.query(
    `SELECT v.reg_no, v.maker, v.model, uv.check_count, uv.last_checked_at
       FROM user_vehicles uv
       JOIN vehicles v ON v.id = uv.vehicle_id
      WHERE uv.user_id = $1
      ORDER BY uv.last_checked_at DESC
      LIMIT $2`, [userId, limit]);
  return rows;
}

/** Store a whole gateway response: vehicle row, snapshots and the link. */
async function record(userId, data) {
  const vehicle = await upsertVehicle(data.vehicle_number, data.rc || {});
  await saveSnapshot(vehicle.id, 'rc', data.rc || {},
    { source: data.source, ttlMinutes: 60 * 24 * 7 });
  if (data.challans) {
    await saveSnapshot(vehicle.id, 'challan', data.challans, { ttlMinutes: 60 * 12 });
  }
  if (data.fastag) {
    await saveSnapshot(vehicle.id, 'fastag', data.fastag, { ttlMinutes: 60 * 24 * 7 });
  }
  if (userId) await linkUserVehicle(userId, vehicle.id);
  return vehicle;
}

module.exports = {
  upsertUser, upsertVehicle, saveSnapshot, linkUserVehicle,
  watchedBy, checkedBy, record,
};
