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
const settings = require('../util/settings');

const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/**
 * Find or create the person behind a mobile number.
 *
 * is_internal is derived from a setting rather than set by hand, so it survives
 * a database reset and can be changed from an admin screen. It does two things:
 * keeps the founder's own constant testing out of customer analytics, and
 * exempts it from every check limit.
 */
async function upsertUser(mobile, { name, waId } = {}) {
  const internal = String(await settings.get('internal_mobiles', ''))
    .split(',').map(s => s.trim()).filter(Boolean)
    .includes(String(mobile));

  // WhatsApp reports the profile name on the CONTACT of an inbound message, not
  // on the message, so most call sites have no name to pass. The session
  // already captured it when the message arrived — take it from there rather
  // than leaving every invoice addressed to a phone number.
  let profileName = name;
  if (!profileName) {
    const s = await db.one(
      `SELECT profile_name FROM whatsapp_sessions WHERE mobile = $1`, [mobile]);
    profileName = s?.profile_name || null;
  }

  const { rows } = await db.query(
    `INSERT INTO users (mobile, wa_profile_name, wa_id, signup_channel, is_internal)
          VALUES ($1, $2, $3, 'whatsapp', $4)
     ON CONFLICT (mobile) DO UPDATE
            SET last_seen_at     = now(),
                modified_at      = now(),
                wa_profile_name  = COALESCE(EXCLUDED.wa_profile_name, users.wa_profile_name),
                wa_id            = COALESCE(EXCLUDED.wa_id, users.wa_id),
                is_internal      = EXCLUDED.is_internal
      RETURNING *`,
    [mobile, profileName, waId || null, internal]);
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
    `SELECT w.id, w.expires_on, w.expires_at, w.is_active, w.subscription_id,
            v.reg_no, v.maker, v.model,
            v.insurance_upto, v.pucc_upto, v.fitness_upto, v.tax_upto, v.permit_upto
       FROM watches w
       JOIN vehicles v ON v.id = w.vehicle_id
      WHERE w.user_id = $1 AND w.is_active
      ORDER BY w.created_at`, [userId]);
  return rows;
}

/**
 * Vehicles this person has checked before, most recent first.
 *
 * The expiry columns come along because they are what makes a picker worth
 * showing: "KA31N8147 — Insurance expired 5 years ago" is a reason to tap,
 * where a bare list of plates is just a list of plates. None of it costs a
 * lookup; it is all already stored.
 */
async function checkedBy(userId, limit = 9) {
  const { rows } = await db.query(
    `SELECT v.id, v.reg_no, v.maker, v.model, v.vehicle_class,
            v.insurance_upto, v.pucc_upto, v.fitness_upto, v.tax_upto, v.permit_upto,
            uv.check_count, uv.last_checked_at,
            EXISTS (SELECT 1 FROM watches w
                     WHERE w.user_id = uv.user_id AND w.vehicle_id = v.id
                       AND w.is_active) AS watched
       FROM user_vehicles uv
       JOIN vehicles v ON v.id = uv.vehicle_id
      WHERE uv.user_id = $1
      ORDER BY uv.last_checked_at DESC
      LIMIT $2`, [userId, limit]);
  return rows;
}

/**
 * What each upstream call cost us.
 *
 * ULIP is free today, so every row lands at zero — which is exactly the point.
 * Cost cannot be reconstructed backwards: the day ULIP starts charging, the
 * only way to answer "what does a customer cost per cycle" is to already have
 * the calls recorded. Setting a rate is then one UPDATE, and everything from
 * that moment carries its price.
 *
 * Rates are per dataset because ULIP will not charge the same for a single RC
 * lookup and an e-challan query that can return three hundred rows.
 */
const DATASET_OF = (path) => {
  const p = String(path || '').toUpperCase();
  if (p.startsWith('VAHAN')) return 'rc';
  if (p.startsWith('ECHALLAN')) return 'challan';
  if (p.startsWith('FASTAG')) return 'fastag';
  return 'other';
};

const COST_KEY = {
  rc: 'ulip_cost_paise_vahan',
  challan: 'ulip_cost_paise_challan',
  fastag: 'ulip_cost_paise_fastag',
};

async function recordCalls(userId, vehicleId, data) {
  const calls = data.calls || [];

  // A cache hit is recorded too. Without it the hit-rate is invisible, and the
  // hit-rate is the entire defence against a per-call price.
  if (!calls.length) {
    await db.query(
      `INSERT INTO api_calls (user_id, vehicle_id, reg_no, dataset, cache_hit, ok, outcome, cost_paise)
            VALUES ($1, $2, $3, 'all', true, true, 'CACHED', $4)`,
      [userId || null, vehicleId, data.vehicle_number,
       await settings.num('cache_hit_cost_paise', 0)]);
    return;
  }

  for (const c of calls) {
    const dataset = DATASET_OF(c.path);
    const cost = COST_KEY[dataset]
      ? await settings.num(COST_KEY[dataset], 0)
      : 0;
    await db.query(
      `INSERT INTO api_calls
         (user_id, vehicle_id, reg_no, dataset, provider_path, cache_hit,
          ok, outcome, error_code, duration_ms, cost_paise)
       VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,$9,$10)`,
      [userId || null, vehicleId, data.vehicle_number, dataset, c.path,
       c.outcome === 'FOUND', c.outcome || null,
       c.outcome === 'FOUND' ? null : String(c.code ?? ''), c.ms || null, cost]);
  }
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
  // Cost last: it must never be the reason a lookup appears to have failed.
  await recordCalls(userId, vehicle.id, data)
    .catch(e => console.error('[store] api_calls:', e.message));
  return vehicle;
}

module.exports = {
  upsertUser, upsertVehicle, saveSnapshot, linkUserVehicle,
  watchedBy, checkedBy, record, recordCalls,
};
