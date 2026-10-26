/**
 * src/vehicle/rcConfirm.js — A FRESH RC BEFORE WE WARN ABOUT A DATE (user, 2026-10-20: "I already got a
 * complaint that the user renewed PUCC but still sees the old one").
 *
 * ULIP's VAHAN answers for yellow-plate (commercial / transport) vehicles only — ULIP told the user so.
 * For a private vehicle every RC re-check came back empty, monitoring fell back to the RC saved at the
 * purchase (rc_saved), and a document renewed since then still showed — and was warned about — as old.
 *
 * refresh() is asked ONLY when GaadiPe is about to say a document is expiring or expired:
 *   1. a full fresh lookup (refresh=1): ULIP first (free; answers for commercial vehicles), and when ULIP
 *      has no RC the paid RC source (IDSPay, ~₹2.95; vehicle/rcBackup.js — its flag and daily limit apply)
 *   2. the answer is stored (vehicle row + snapshots, vehicle/store.record), so the renewed date replaces
 *      the old one for alerts, status updates and reports alike — and rc_saved serves the new one after
 *   3. at most once per vehicle per rc_confirm_days (3): a vehicle confirmed recently is not paid for
 *      again — its stored dates ARE the fresh ones
 * Returns the fresh gateway answer, or null (recently confirmed, or the lookup failed — callers then use
 * the stored dates, as before).
 */
const db = require('../db');
const settings = require('../util/settings');

const DATE_FIELDS = ['insurance_upto', 'pucc_upto', 'tax_upto', 'fitness_upto', 'permit_upto',
  'insuranceUpto', 'puccUpto', 'fitnessUpto', 'permitUpto', 'taxUpto'];

/**
 * Does this RC hold a document expiring within `days`, or lapsed in the last week? (What would make us
 * warn.) Not one lapsed long ago (2026-10-21): an owner who never renewed made it true every time, and
 * each time cost a paid lookup for nothing (expiryWatch uses the same 7-day look-back).
 */
function needsConfirm(rc, days = 30) {
  if (!rc) return false;
  const soon = Date.now() + days * 864e5;
  const since = Date.now() - 7 * 864e5;
  return DATE_FIELDS.some((f) => {
    const v = rc[f]; if (!v) return false;
    const t = new Date(v).getTime();
    return Number.isFinite(t) && t <= soon && t >= since;
  });
}

/* NOT PAID FOR TWICE (user, 2026-10-26: "it's creating loss"). A free check fetched the full RC (Way2API,
   IDSPay, ULIP) minutes before the customer paid, and the paid report's refresh bought the same record again.
   A full RC stored within the window counts as confirmed too - only eChallan.app's four fields do not. */
async function recentlyConfirmed(vehicleId, hours = null) {
  const h = Math.max(1, Math.round(hours ?? Math.max(1, await settings.num('rc_confirm_days', 3)) * 24));
  const row = await db.one(
    `SELECT 1 AS yes FROM event_log WHERE kind = 'rc_confirm' AND (detail->>'vehicle_id')::bigint = $1
        AND created_at > now() - make_interval(hours => $2::int)
     UNION ALL
     SELECT 1 FROM vehicle_snapshots WHERE vehicle_id = $1 AND dataset = 'rc'
        AND coalesce(source, '') <> 'ECHALLANAPP' AND data ? 'insurance_upto'
        AND fetched_at > now() - make_interval(hours => $2::int)
     LIMIT 1`, [vehicleId, h]).catch(() => null);
  return Boolean(row);
}

async function refresh({ regNo, vehicleId, userId = null, why = '', hours = null }) {
  if (!regNo || !vehicleId) return null;
  if (await recentlyConfirmed(vehicleId, hours)) return null;
  // Claimed first: two jobs (expiry, monitoring) asking in the same minute pay once.
  await db.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'rc_confirm', $2)`,
    [userId, JSON.stringify({ vehicle_id: String(vehicleId), reg_no: regNo, why })]);
  let data = null;
  try { data = await require('./gateway').full(regNo, { refresh: 1 }); } catch (e) { data = null; }
  if (!data?.success || !data.rc) {
    console.warn('[rc-confirm] %s: fresh RC not available (%s)', regNo, data?.error || data?.message || 'no answer');
    return null;
  }
  await require('./store').record(userId, data, { link: false })
    .catch((e) => console.error('[rc-confirm] store %s: %s', regNo, e.message));
  console.log('[rc-confirm] %s refreshed for %s (RC from %s)', regNo, why || 'an alert', data.rc_source || data.source || 'the records');
  return data;
}

/*
 * A PAYING CUSTOMER LOOKS AT THEIR OWN VEHICLE (user, 2026-10-20: "on full report and the next time the
 * user checks any vehicle or My reports, call IDSPay to get updated details — to get customers I need
 * the updated ones; I treat this as an investment until a cheaper provider"). A vehicle they hold a
 * valid report for, checked again or its report opened: one fresh lookup first (ULIP, then the paid
 * source), at most once per vehicle per rc_owner_refresh_hours (24), stored — so what they see next,
 * from the cache or the snapshot, is today's record. Never throws; the caller carries on regardless.
 */
async function ownerRefresh({ regNo, userId = null, why = 'owner' }) {
  try {
    const v = await db.one(`SELECT id FROM vehicles WHERE reg_no = $1`, [regNo]);
    if (!v) return null;
    const hours = Math.max(1, await settings.num('rc_owner_refresh_hours', 24));
    return await refresh({ regNo, vehicleId: v.id, userId, why, hours });
  } catch (e) {
    console.error('[rc-confirm] owner refresh %s: %s', regNo, e.message);
    return null;
  }
}

module.exports = { refresh, ownerRefresh, needsConfirm, recentlyConfirmed };
