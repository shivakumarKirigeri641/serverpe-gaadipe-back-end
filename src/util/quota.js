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
            -- A Rs.19 report is not a subscription for this purpose: it must
            -- not buy unlimited free checks for 28 days.
            EXISTS (SELECT 1 FROM subscriptions s
                      JOIN plans pl ON pl.id = s.plan_id
                     WHERE s.user_id = u.id AND s.is_active
                       AND pl.kind <> 'report')                       AS paying,
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

  // The month too (user, 2026-10-10): 30, and 5 more for every report bought this month.
  const month = await monthOf(userId, tier);
  if (month && month.used >= month.limit) {
    return { allowed: !enforced, reason: 'monthly', tier, used: month.used, limit: month.limit,
             bonus: month.bonus, perReport: month.perReport, repeat: false, enforced };
  }

  return { allowed: true, tier, used: today.n, limit: dailyLimit, repeat: false, enforced };
}

/** The calendar month in IST, as SQL. */
const MONTH = `date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`;

/*
 * THE MONTHLY ALLOWANCE (user, 2026-10-10: "pay a report to unlock more — 5").
 * free_checks_per_month (30) for a free customer, plus checks_per_report_bonus (5)
 * for every report paid this month — ₹19 or ₹11. A partner or internal account
 * has no monthly cap. Null when there is none.
 */
async function monthOf(userId, tier) {
  if (!['stranger', 'trial'].includes(tier)) return null;
  const base = await settings.num('free_checks_per_month', 30);
  if (base <= 0) return null;
  const perReport = await settings.num('checks_per_report_bonus', 5);
  const row = await db.one(
    `SELECT (SELECT count(*) FROM event_log WHERE kind = 'vehicle_check' AND user_id = $1
               AND created_at >= ${MONTH})::int AS used,
            (SELECT count(*) FROM payments p JOIN plans pl ON pl.id = p.plan_id
              WHERE p.user_id = $1 AND p.status = 'paid' AND p.amount_paise > 0 AND pl.kind = 'report'
                AND coalesce(p.paid_at, p.created_at) >= ${MONTH})::int AS reports`, [userId]);
  const bonus = row.reports * perReport;
  return { used: row.used, limit: base + bonus, base, bonus, perReport, reports: row.reports };
}

/**
 * What this customer has left — for the chat to show (user, 2026-10-10: "show the
 * vehicle check count to users when they sign in, updated when they purchase").
 *   { unlimited } or { today: {used, limit, left}, month: {used, limit, left, bonus, per_report} }
 */
async function left(userId) {
  const tier = await tierOf(userId);
  if (tier === 'subscriber' || tier === 'internal') return { unlimited: true, tier };
  const dailyLimit = await settings.num(DAILY_KEY[tier] || DAILY_KEY.stranger, 20);
  const today = await db.one(
    `SELECT count(*)::int AS n FROM event_log
      WHERE kind = 'vehicle_check' AND user_id = $1
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`, [userId]);
  const m = await monthOf(userId, tier);
  const day = { used: today.n, limit: dailyLimit, left: Math.max(0, dailyLimit - today.n) };
  // A day's checks can never be more than the month has left.
  if (m) day.left = Math.min(day.left, Math.max(0, m.limit - m.used));
  return {
    tier, enforced: await settings.bool('checks_enforce', false), today: day,
    month: m ? { used: m.used, limit: m.limit, left: Math.max(0, m.limit - m.used), bonus: m.bonus, per_report: m.perReport, base: m.base } : null,
  };
}

/**
 * Record a check that actually happened. A repeat inside the window is kept
 * under its own kind, vehicle_check_repeat (user, 2026-10-03: "count every
 * check, distinct or repeated"), so it never counts towards a limit — every
 * limit above reads vehicle_check only.
 */
async function record(userId, regNo, { repeat = false, found = true, channel = null } = {}) {
  // channel 'web' marks a website check, so the website admin can count its own (2026-10-07).
  await db.query(
    `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, $2, $3)`,
    [userId, repeat ? 'vehicle_check_repeat' : 'vehicle_check', JSON.stringify({ reg_no: regNo, found, ...(channel ? { channel } : {}) })]);
  // The plain-words activity log (2026-10-08).
  try {
    const u = userId ? await db.one(`SELECT coalesce(display_name, wa_profile_name) AS name, mobile FROM users WHERE id = $1`, [userId]) : null;
    require('./activity').log('🔍', `Vehicle checked${repeat ? ' again' : ''} · ${regNo} · ${found ? 'found' : 'not found'}`,
      { who: require('./activity').who(u?.name, u?.mobile), detail: channel ? `on ${channel === 'web' ? 'the website' : channel}` : null });
  } catch { /* the log never stops a check */ }
}

module.exports = { check, record, tierOf, left };
