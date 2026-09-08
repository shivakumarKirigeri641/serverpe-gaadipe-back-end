/**
 * src/util/quota.js
 * ---------------------------------------------------------------------------
 * How many vehicle checks this person may still make.
 *
 * Counts CALLS, not distinct vehicles, because a call is what costs money —
 * someone re-checking one plate two hundred times spends two hundred lookups
 * and would never trip a distinct-vehicle counter.
 *
 * What that would make unfair is repeats, so one rule fixes it: the same
 * vehicle inside checks_repeat_window_minutes does not count. People re-read a
 * report they were just sent, or show it to the person selling them the bike.
 * Charging for that would feel broken; charging for the same plate five hours
 * later is correct.
 *
 * Nothing here refuses anyone while checks_enforce is false. Counting still
 * happens, so the limits can eventually be set from evidence.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const settings = require('./settings');

/**
 * Which bucket is this person in? Read fresh each time rather than cached: a
 * trial starting mid-conversation must widen the limit immediately, not a
 * minute later.
 */
async function tierOf(userId) {
  const u = await db.one(
    `SELECT is_internal,
            EXISTS (SELECT 1 FROM subscriptions s
                     WHERE s.user_id = u.id AND s.is_active)          AS paying,
            EXISTS (SELECT 1 FROM watches w
                     WHERE w.user_id = u.id AND w.is_active)          AS watching,
            EXISTS (SELECT 1 FROM partners p
                     WHERE p.user_id = u.id AND p.status = 'active')  AS partner
       FROM users u WHERE u.id = $1`, [userId]);

  if (!u) return 'stranger';
  if (u.is_internal) return 'internal';
  if (u.paying) return 'subscriber';
  if (u.partner) return 'partner';
  if (u.watching) return 'trial';
  return 'stranger';
}

const DAILY_KEY = {
  stranger: 'free_checks_per_day',
  trial: 'free_checks_per_day_trial',
  partner: 'free_checks_per_day_partner',
};

/**
 * May this person check this vehicle right now?
 *
 * @returns {{allowed:boolean, reason?:string, tier:string, used:number,
 *            limit:number|null, repeat:boolean, enforced:boolean}}
 */
async function check(userId, regNo) {
  const tier = await tierOf(userId);
  const enforced = await settings.bool('checks_enforce', false);

  // Unlimited tiers short-circuit: no counting, no queries, no surprises.
  if (tier === 'subscriber' || tier === 'internal') {
    return { allowed: true, tier, used: 0, limit: null, repeat: false, enforced };
  }

  const repeatWindow = await settings.num('checks_repeat_window_minutes', 60);
  const recentSame = await db.one(
    `SELECT 1 FROM event_log
      WHERE kind = 'vehicle_check' AND user_id = $1
        AND detail->>'reg_no' = $2
        AND created_at > now() - ($3 || ' minutes')::interval
      LIMIT 1`, [userId, regNo, String(repeatWindow)]);

  // A repeat inside the window is free and is not even counted, so it can
  // never push someone over a limit.
  if (recentSame) {
    return { allowed: true, tier, used: 0, limit: null, repeat: true, enforced };
  }

  const burstLimit = await settings.num('checks_burst_per_minute', 5);
  const burst = await db.one(
    `SELECT count(*)::int AS n FROM event_log
      WHERE kind = 'vehicle_check' AND user_id = $1
        AND created_at > now() - interval '1 minute'`, [userId]);

  if (burst.n >= burstLimit) {
    return { allowed: !enforced, reason: 'burst', tier,
             used: burst.n, limit: burstLimit, repeat: false, enforced };
  }

  const dailyLimit = await settings.num(DAILY_KEY[tier] || DAILY_KEY.stranger, 20);
  const today = await db.one(
    `SELECT count(*)::int AS n FROM event_log
      WHERE kind = 'vehicle_check' AND user_id = $1
        -- Calendar day in IST: "resets tomorrow" is a sentence people
        -- understand, and a rolling 24-hour window is one they argue with.
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
                          AT TIME ZONE 'Asia/Kolkata'`, [userId]);

  if (today.n >= dailyLimit) {
    return { allowed: !enforced, reason: 'daily', tier,
             used: today.n, limit: dailyLimit, repeat: false, enforced };
  }

  return { allowed: true, tier, used: today.n, limit: dailyLimit, repeat: false, enforced };
}

/** Record a check that actually happened. Repeats inside the window are not. */
async function record(userId, regNo, { repeat = false, found = true } = {}) {
  if (repeat) return;
  await db.query(
    `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'vehicle_check', $2)`,
    [userId, JSON.stringify({ reg_no: regNo, found })]);
}

module.exports = { check, record, tierOf };
