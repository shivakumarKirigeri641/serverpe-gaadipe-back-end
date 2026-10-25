/**
 * src/util/own.js — IS THIS ONE OF US? (user, 2026-10-25: "remove my logs when I do some activities").
 *
 * GaadiPe's own numbers (users.is_internal), held in memory and refreshed every minute, so the server's live log
 * can leave out the owner's own taps and checks without a database read per line. Synchronous on purpose: the log
 * writers cannot wait. Only the LOG lines are skipped - the records themselves are still written, so the admin's
 * own-number filters keep working as before.
 */
const ids = new Set();
const mobiles = new Set();

async function refresh() {
  try {
    const { rows } = await require('../db').query(
      `SELECT id, right(regexp_replace(coalesce(mobile, ''), '\\D', '', 'g'), 10) AS m FROM users WHERE is_internal`);
    ids.clear(); mobiles.clear();
    for (const r of rows) {
      ids.add(String(r.id));
      if (r.m && r.m.length === 10) mobiles.add(r.m);
    }
  } catch { /* keep the last list */ }
}
refresh();
setInterval(refresh, 60 * 1000).unref();

const ten = (m) => String(m || '').replace(/\D/g, '').slice(-10);

/** True for GaadiPe's own user id or mobile number. */
function isOwn({ userId = null, mobile = null } = {}) {
  if (userId != null && ids.has(String(userId))) return true;
  const m = ten(mobile);
  return m.length === 10 && mobiles.has(m);
}

module.exports = { isOwn, refresh };
