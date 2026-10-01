/**
 * src/owners/verify.js — "prove this vehicle is yours" (user, 2026-10-01).
 *
 * HOW: two things printed on the owner's RC that the Government record holds
 * but GaadiPe never shows in full —
 *   1. the CHASSIS number. ULIP stars its last five characters and GaadiPe
 *      shows only the first, so the characters in between are the secret.
 *   2. the INSURANCE POLICY number (shown to customers as its last 4 digits
 *      only) or, when there is no policy on record, the ENGINE number (shown
 *      as its first character only). Either is accepted when both are held.
 * Both must match, and the customer is told only "matched" or "did not
 * match" — never which part was wrong.
 *
 * WHAT IT PROVES: the person has the RC (or the vehicle and its papers) in
 * hand. It is not a legal title check; the admin can reject or revoke any
 * claim, and approve one by hand after seeing an RC photo.
 *
 * LIMITS: settings owner_verification_max_attempts (3) failures for one
 * number on one vehicle lock it for owner_verification_lock_hours (24). A
 * vehicle failed by several numbers in a day, or a number failing on several
 * vehicles, stops too — that is guessing, not forgetting.
 *
 * PRIVACY: what was typed is never stored or logged — `checks` holds only
 * which parts matched. Every finished attempt is a row here, which is the
 * audit trail; admin actions also go to admin_audit.
 *
 * Behind the owner_verification flag (off until switched on).
 */

const db = require('../db');
const settings = require('../util/settings');

const clean = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9*]/g, '');

/** The part of a stored number we can compare: everything before the stars. */
function visible(stored) {
  const c = clean(stored);
  const star = c.indexOf('*');
  return { part: star < 0 ? c : c.slice(0, star), masked: star >= 0 };
}

/**
 * Does what they typed agree with what we hold? Null when we hold too little
 * of it to ask. A starred number must match the whole visible part (what
 * they type past it cannot be checked); a whole number must match exactly.
 */
function agrees(stored, typed, minVisible) {
  const v = visible(stored);
  if (v.part.length < minVisible) return null;
  const t = clean(typed).replace(/\*/g, '');
  return v.masked ? t.length >= v.part.length && t.startsWith(v.part) : t === v.part;
}

const MIN = { chassis: 8, policy: 6, engine: 5 };

async function enabled() {
  return require('../util/flags').on('owner_verification');
}

/** The RC we hold for a registration, from the last lookup. */
async function storedRc(regNo) {
  const row = await db.one(
    `SELECT v.id AS vehicle_id, s.data
       FROM vehicles v JOIN vehicle_snapshots s ON s.vehicle_id = v.id AND s.dataset = 'rc'
      WHERE v.reg_no = $1`, [regNo]);
  return row ? { vehicleId: row.vehicle_id, rc: row.data || {} } : null;
}

/** Which second proof this RC allows: 'policy', 'engine', 'either' or null. */
function secondFor(rc) {
  const policy = visible(rc.insurance_policy).part.length >= MIN.policy;
  const engine = visible(rc.engine).part.length >= MIN.engine;
  return policy && engine ? 'either' : policy ? 'policy' : engine ? 'engine' : null;
}

/** The verified claim for this number and vehicle, if there is one. */
async function verifiedClaim(mobile, regNo) {
  return db.one(
    `SELECT * FROM vehicle_owner_claims
      WHERE mobile = $1 AND reg_no = $2 AND status = 'verified'
      ORDER BY verified_at DESC LIMIT 1`, [mobile, regNo]);
}

/** Is this number a verified owner of this vehicle? */
async function isOwner(mobile, regNo) {
  if (!mobile || !regNo) return false;
  return Boolean(await verifiedClaim(mobile, regNo).catch(() => null));
}

/**
 * Has a verified owner hidden this vehicle from this person? The owner
 * themselves always sees it. Works even with the flag off, so switching the
 * feature off never un-hides anyone's vehicle without them knowing.
 */
async function hiddenFrom(mobile, regNo) {
  const row = await db.one(
    `SELECT 1 FROM vehicle_owner_claims
      WHERE reg_no = $1 AND status = 'verified' AND hidden_at IS NOT NULL
        AND mobile IS DISTINCT FROM $2
      LIMIT 1`, [regNo, mobile || null]).catch(() => null);
  return Boolean(row);
}

/** Why this number cannot try this vehicle now, or null. */
async function blocker(mobile, regNo) {
  const max = await settings.num('owner_verification_max_attempts', 3);
  const lock = await db.one(
    `SELECT max(locked_until) AS until FROM vehicle_owner_claims
      WHERE mobile = $1 AND reg_no = $2 AND counted AND locked_until > now()`, [mobile, regNo]);
  if (lock?.until) return { reason: 'locked', lockedUntil: lock.until };

  const perVehicle = await settings.num('owner_verification_vehicle_daily_failures', 6);
  const perMobile = await settings.num('owner_verification_mobile_daily_failures', 6);
  const day = await db.one(
    `SELECT count(DISTINCT mobile) FILTER (WHERE reg_no = $2)  AS numbers,
            count(*)               FILTER (WHERE mobile = $1)  AS by_me
       FROM vehicle_owner_claims
      WHERE status IN ('failed', 'locked') AND counted AND created_at > now() - interval '24 hours'
        AND (reg_no = $2 OR mobile = $1)`, [mobile, regNo]);
  if (Number(day?.numbers) >= perVehicle) return { reason: 'vehicle_busy' };
  if (Number(day?.by_me) >= Math.max(perMobile, max)) return { reason: 'too_many' };
  return null;
}

/**
 * Start a claim. The vehicle must have been looked up (its RC is what we
 * compare against). Returns { ok, claimId, second } or { ok: false, reason }.
 */
async function begin({ userId, mobile, regNo }) {
  if (!await enabled()) return { ok: false, reason: 'off' };
  if (await verifiedClaim(mobile, regNo)) return { ok: false, reason: 'already' };
  const held = await storedRc(regNo);
  if (!held) return { ok: false, reason: 'no_record' };
  const second = secondFor(held.rc);
  if (agrees(held.rc.chassis, '', MIN.chassis) === null || !second) return { ok: false, reason: 'not_checkable' };
  const stop = await blocker(mobile, regNo);
  if (stop) return { ok: false, ...stop };

  // One open claim at a time: an older unfinished one is closed, uncounted.
  await db.query(
    `UPDATE vehicle_owner_claims SET status = 'failed', counted = false, note = 'not finished', modified_at = now()
      WHERE mobile = $1 AND status = 'pending'`, [mobile]);
  const row = await db.one(
    `INSERT INTO vehicle_owner_claims (user_id, mobile, vehicle_id, reg_no, checks)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId || null, mobile, held.vehicleId, regNo, JSON.stringify({ second })]);
  return { ok: true, claimId: String(row.id), second };
}

/** Step 1: the chassis. Remembered as matched or not; the customer is not told. */
async function answerChassis(claimId, typed) {
  const c = await db.one(`SELECT * FROM vehicle_owner_claims WHERE id = $1 AND status = 'pending'`, [claimId]);
  if (!c) return { ok: false, reason: 'lost' };
  const held = await storedRc(c.reg_no);
  const match = Boolean(held && agrees(held.rc.chassis, typed, MIN.chassis));
  await db.query(
    `UPDATE vehicle_owner_claims SET checks = checks || $2::jsonb, modified_at = now() WHERE id = $1`,
    [claimId, JSON.stringify({ chassis: match })]);
  return { ok: true, second: c.checks?.second || 'policy' };
}

/**
 * Step 2: the policy or engine number, and the verdict.
 * Returns { ok: true } verified, or { ok: false, reason: 'wrong', attemptsLeft }
 * / { ok: false, reason: 'locked', lockedUntil } / { ok: false, reason: 'lost' }.
 */
async function answerSecond(claimId, typed) {
  const c = await db.one(`SELECT * FROM vehicle_owner_claims WHERE id = $1 AND status = 'pending'`, [claimId]);
  if (!c) return { ok: false, reason: 'lost' };
  const held = await storedRc(c.reg_no);
  const rc = held?.rc || {};
  const second = c.checks?.second;
  const policy = second !== 'engine' && Boolean(agrees(rc.insurance_policy, typed, MIN.policy));
  const engine = second !== 'policy' && Boolean(agrees(rc.engine, typed, MIN.engine));
  const chassis = c.checks?.chassis === true;
  const ok = chassis && (policy || engine);
  const checks = { ...c.checks, policy, engine };

  if (ok) {
    await db.query(
      `UPDATE vehicle_owner_claims SET status = 'verified', checks = $2, attempts = 1, verified_at = now(), modified_at = now()
        WHERE id = $1`, [claimId, JSON.stringify(checks)]);
    await db.query(`INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'owner_verified', $3)`,
      [c.user_id, c.vehicle_id, JSON.stringify({ claim: claimId, by: policy ? 'chassis+policy' : 'chassis+engine' })]).catch(() => {});
    return { ok: true, regNo: c.reg_no };
  }

  const max = await settings.num('owner_verification_max_attempts', 3);
  const hours = await settings.num('owner_verification_lock_hours', 24);
  const prior = await db.one(
    `SELECT count(*) AS n FROM vehicle_owner_claims
      WHERE mobile = $1 AND reg_no = $2 AND counted AND status IN ('failed', 'locked')
        AND created_at > now() - ($3 || ' hours')::interval`, [c.mobile, c.reg_no, String(hours)]);
  const failures = Number(prior?.n || 0) + 1;
  const lock = failures >= max;
  const after = await db.one(
    `UPDATE vehicle_owner_claims
        SET status = $2, checks = $3, attempts = $4, modified_at = now(),
            locked_until = CASE WHEN $5 THEN now() + ($6 || ' hours')::interval END
      WHERE id = $1 RETURNING locked_until`,
    [claimId, lock ? 'locked' : 'failed', JSON.stringify(checks), failures, lock, String(hours)]);
  await db.query(`INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'owner_verify_failed', $3)`,
    [c.user_id, c.vehicle_id, JSON.stringify({ claim: claimId, failures, locked: lock })]).catch(() => {});
  return lock
    ? { ok: false, reason: 'locked', lockedUntil: after?.locked_until }
    : { ok: false, reason: 'wrong', attemptsLeft: max - failures };
}

/** A verified owner hides or shows their vehicle. */
async function setHidden(mobile, regNo, hidden) {
  const { rowCount } = await db.query(
    `UPDATE vehicle_owner_claims SET hidden_at = CASE WHEN $3 THEN now() END, modified_at = now()
      WHERE mobile = $1 AND reg_no = $2 AND status = 'verified'`, [mobile, regNo, Boolean(hidden)]);
  return rowCount > 0;
}

/** The vehicles this number has verified. */
async function mine(mobile) {
  const { rows } = await db.query(
    `SELECT reg_no, verified_at, hidden_at FROM vehicle_owner_claims
      WHERE mobile = $1 AND status = 'verified' ORDER BY verified_at DESC`, [mobile]);
  return rows;
}

/* ─────────────────────────── the admin panel ─────────────────────────── */

const mask = (m) => (m ? `••••••${String(m).slice(-4)}` : null);

async function list({ status = null, q = null, limit = 300 } = {}) {
  const { rows } = await db.query(
    `SELECT c.id, c.mobile, c.reg_no, c.status, c.checks, c.attempts, c.locked_until, c.verified_at,
            c.hidden_at, c.counted, c.note, c.created_at, c.modified_at,
            u.name, a.name AS reviewed_by_name
       FROM vehicle_owner_claims c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN admin_users a ON a.id = c.reviewed_by
      WHERE ($1::text IS NULL OR c.status = $1)
        AND ($2::text IS NULL OR c.reg_no ILIKE '%' || $2 || '%' OR c.mobile LIKE '%' || $2 || '%')
      ORDER BY c.created_at DESC LIMIT $3`, [status || null, q ? String(q).toUpperCase().replace(/[^A-Z0-9]/g, '') || null : null, limit]);
  const { rows: totals } = await db.query(
    `SELECT status, count(*)::int AS n FROM vehicle_owner_claims GROUP BY status`);
  return {
    enabled: await enabled(),
    totals: Object.fromEntries(totals.map((t) => [t.status, t.n])),
    rows: rows.map((r) => ({ ...r, id: String(r.id), masked: mask(r.mobile), mobile: undefined })),
  };
}

/**
 * approve  mark verified by hand (after seeing an RC photo, say)
 * reject   a claim the admin does not accept — the badge goes
 * revoke   a verified owner who is no longer the owner (sold the vehicle)
 * unlock   let this number try this vehicle again now
 */
async function review({ id, action, note, adminId, ip }) {
  const c = await db.one(`SELECT * FROM vehicle_owner_claims WHERE id = $1`, [id]);
  if (!c) return { ok: false, message: 'No such claim.' };
  const why = note ? String(note).slice(0, 300) : null;
  if (action === 'approve') {
    if (c.status === 'verified') return { ok: false, message: 'Already verified.' };
    await db.query(
      `UPDATE vehicle_owner_claims SET status = 'verified', verified_at = now(), locked_until = NULL,
              reviewed_by = $2, note = coalesce($3, 'approved by admin'), modified_at = now() WHERE id = $1`, [id, adminId || null, why]);
  } else if (action === 'reject' || action === 'revoke') {
    await db.query(
      `UPDATE vehicle_owner_claims SET status = $4, hidden_at = NULL, reviewed_by = $2, note = coalesce($3, note), modified_at = now()
        WHERE id = $1`, [id, adminId || null, why, action === 'reject' ? 'rejected' : 'revoked']);
  } else if (action === 'unlock') {
    await db.query(
      `UPDATE vehicle_owner_claims SET counted = false, locked_until = NULL, reviewed_by = $3, modified_at = now()
        WHERE mobile = $1 AND reg_no = $2 AND status IN ('failed', 'locked')`, [c.mobile, c.reg_no, adminId || null]);
  } else {
    return { ok: false, message: 'Unknown action.' };
  }
  await require('../admin/auth').audit({ adminId, action: `owner_claim_${action}`, ip,
    detail: { claim: String(id), reg_no: c.reg_no, mobile: mask(c.mobile), note: why } });
  return { ok: true };
}

module.exports = {
  enabled, begin, answerChassis, answerSecond, isOwner, hiddenFrom, setHidden, mine, list, review,
  _test: { agrees, visible, secondFor },
};
