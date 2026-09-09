/**
 * src/vehicle/verify.js
 * ---------------------------------------------------------------------------
 * "Send the first five characters of your chassis number."
 *
 * The whole mechanism rests on one earlier decision: GaadiPe has never
 * displayed a chassis number, to anyone, in any product. That is what makes it
 * a secret worth asking for — if we had ever shown it, asking for it back would
 * verify nothing.
 *
 * ULIP masks the END of the chassis (YV3T7U52XP821391*****), so the prefix is
 * the part we hold and the prefix is what we ask for.
 *
 * WHAT IT PROVES: possession of the RC, or physical access to the vehicle.
 * NOT legal ownership — someone inspecting a car can read the chassis plate.
 * The badge says "RC verified" for that reason.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const settings = require('../util/settings');

/** The chassis we hold for a vehicle, from the stored RC snapshot. */
async function storedChassis(vehicleId) {
  const row = await db.one(
    `SELECT data->>'chassis' AS chassis
       FROM vehicle_snapshots
      WHERE vehicle_id = $1 AND dataset = 'rc'`, [vehicleId]);
  return row?.chassis || null;
}

const clean = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Is this vehicle verified for this person? */
async function isVerified(userId, vehicleId) {
  const row = await db.one(
    `SELECT is_verified FROM vehicle_verifications
      WHERE user_id = $1 AND vehicle_id = $2`, [userId, vehicleId]);
  return Boolean(row?.is_verified);
}

/** Every vehicle this person has verified, by registration number. */
async function verifiedRegNos(userId) {
  const { rows } = await db.query(
    `SELECT v.reg_no FROM vehicle_verifications vv
       JOIN vehicles v ON v.id = vv.vehicle_id
      WHERE vv.user_id = $1 AND vv.is_verified`, [userId]);
  return rows.map(r => r.reg_no);
}

/**
 * Can this vehicle be verified at all?
 *
 * A masked-to-nothing chassis (some records return only asterisks) cannot be
 * checked, and offering a challenge that can never succeed is worse than not
 * offering one.
 */
async function challengeable(vehicleId) {
  const chassis = clean(await storedChassis(vehicleId));
  const need = await settings.num('verify_prefix_length', 5);
  const usable = chassis.replace(/\*+$/, '');
  return usable.length >= need;
}

/**
 * Check an answer.
 * Returns { ok, reason, attemptsLeft, lockedUntil }.
 */
async function attempt(userId, vehicleId, answer) {
  const need = await settings.num('verify_prefix_length', 5);
  const maxAttempts = await settings.num('verify_max_attempts', 3);
  const lockMinutes = await settings.num('verify_lock_minutes', 1440);

  const state = await db.one(
    `INSERT INTO vehicle_verifications (user_id, vehicle_id)
          VALUES ($1, $2)
     ON CONFLICT (user_id, vehicle_id) DO UPDATE SET modified_at = now()
      RETURNING *`, [userId, vehicleId]);

  if (state.is_verified) return { ok: true, reason: 'already' };

  if (state.locked_until && new Date(state.locked_until) > new Date()) {
    return { ok: false, reason: 'locked', lockedUntil: state.locked_until };
  }

  const chassis = clean(await storedChassis(vehicleId));
  const expected = chassis.slice(0, need);
  const given = clean(answer).slice(0, need);

  if (!expected || expected.length < need) {
    return { ok: false, reason: 'not_challengeable' };
  }

  if (given === expected) {
    await db.query(
      `UPDATE vehicle_verifications
          SET is_verified = true, verified_at = now(), attempts = attempts + 1,
              locked_until = NULL, modified_at = now()
        WHERE id = $1`, [state.id]);
    await db.query(
      `INSERT INTO event_log (user_id, vehicle_id, kind, detail)
            VALUES ($1, $2, 'rc_verified', $3)`,
      [userId, vehicleId, JSON.stringify({ method: 'chassis_prefix', length: need })]);
    return { ok: true, reason: 'verified' };
  }

  const attempts = state.attempts + 1;
  const lock = attempts >= maxAttempts;
  await db.query(
    `UPDATE vehicle_verifications
        SET attempts = $2,
            locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END,
            modified_at = now()
      WHERE id = $1`, [state.id, attempts, lock, String(lockMinutes)]);

  return { ok: false, reason: lock ? 'locked_now' : 'wrong',
           attemptsLeft: Math.max(0, maxAttempts - attempts) };
}

module.exports = { attempt, isVerified, verifiedRegNos, challengeable, storedChassis };
