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
  // A cap for subscription plans too (user, 2026-10-25: "otherwise it is a loss for me"; migration 211).
  subscriber: 'free_checks_per_day_subscriber',
};
// Only GaadiPe's own numbers are unlimited.
const UNLIMITED = new Set(['internal']);

/**
 * May this person check this vehicle right now?
 *
 * @returns {{allowed:boolean, reason?:string, tier:string, used:number,
 *            limit:number|null, repeat:boolean, enforced:boolean}}
 */
async function check(userId, regNo) {
  const tier = await tierOf(userId);
  if (PACK_TIERS.has(tier) && await packsOn()) return packCheck(userId, regNo, tier);
  const enforced = await settings.bool('checks_enforce', false);

  // Unlimited tiers short-circuit: no counting, no queries, no surprises.
  if (UNLIMITED.has(tier)) {
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

/*
 * ONE FREE CHECK, THEN CHECK CREDITS (user, 2026-10-26: "1 customer, 1 vehicle check free ... it is becoming a
 * loss"; migration 213). For a customer (stranger / trial): the first free_checks_lifetime (1) found checks are
 * free; after that each new check needs a credit from check_credits - a ₹20 pack of 5, or the 5 that come with
 * every report - used when the check is recorded. Never counted: a repeat of the same vehicle inside the repeat
 * window, a vehicle they hold a valid report for, and a vehicle that was not found (no provider charges for it).
 * Fleet / partner plans keep their daily caps; GaadiPe's own numbers stay unlimited.
 */
const PACK_TIERS = new Set(['stranger', 'trial']);
const packsOn = () => settings.bool('check_packs_enabled', true);

async function ownsValidReport(userId, regNo) {
  const r = await db.one(
    `SELECT 1 AS yes FROM vehicle_reports WHERE user_id = $1 AND reg_no = $2 AND valid_until > now() LIMIT 1`,
    [userId, regNo]).catch(() => null);
  return Boolean(r);
}

async function freeUsed(userId) {
  const r = await db.one(
    `SELECT count(*)::int AS n FROM event_log WHERE kind = 'vehicle_check' AND user_id = $1
        AND coalesce(detail->>'found', 'true') <> 'false' AND coalesce(detail->>'credit', '') = ''`, [userId]);
  return r.n;
}

/** Credits left, and when the soonest of them expires. */
async function creditsOf(userId) {
  const r = await db.one(
    `SELECT coalesce(sum(credits - used), 0)::int AS left, min(expires_at) AS next_expiry, max(expires_at) AS last_expiry
       FROM check_credits WHERE user_id = $1 AND expires_at > now() AND used < credits`, [userId]);
  return { left: r.left, nextExpiry: r.next_expiry, lastExpiry: r.last_expiry };
}

async function packCheck(userId, regNo, tier) {
  const base = { tier, packs: true, enforced: true, limit: null };
  const repeatWindow = await settings.num('checks_repeat_window_minutes', 60);
  const recentSame = await db.one(
    `SELECT 1 FROM event_log WHERE kind = 'vehicle_check' AND user_id = $1 AND detail->>'reg_no' = $2
        AND created_at > now() - ($3 || ' minutes')::interval LIMIT 1`, [userId, regNo, String(repeatWindow)]);
  if (recentSame) return { ...base, allowed: true, repeat: true, used: 0 };
  if (await ownsValidReport(userId, regNo)) return { ...base, allowed: true, repeat: false, owned: true, used: 0 };

  const burstLimit = await settings.num('checks_burst_per_minute', 5);
  const burst = await db.one(
    `SELECT count(*)::int AS n FROM event_log WHERE kind = 'vehicle_check' AND user_id = $1
        AND created_at > now() - interval '1 minute'`, [userId]);
  if (burst.n >= burstLimit) return { ...base, allowed: false, reason: 'burst', repeat: false, used: burst.n, limit: burstLimit };

  const freeLimit = await settings.num('free_checks_lifetime', 1);
  const used = await freeUsed(userId);
  if (used < freeLimit) return { ...base, allowed: true, repeat: false, free: true, used, limit: freeLimit };
  const c = await creditsOf(userId);
  if (c.left > 0) return { ...base, allowed: true, repeat: false, credit: true, used, creditsLeft: c.left };
  return { ...base, allowed: false, reason: 'no_credits', repeat: false, used, limit: freeLimit };
}

/** Use one credit, the soonest to expire. Returns true if one was there. */
async function consume(userId) {
  const r = await db.one(
    `UPDATE check_credits SET used = used + 1
      WHERE id = (SELECT id FROM check_credits WHERE user_id = $1 AND expires_at > now() AND used < credits
                   ORDER BY expires_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id`, [userId]);
  return Boolean(r);
}

/** Add credits for a payment (pay/billing.activate) - once per payment. */
async function grant(client, { userId, paymentId = null, source, credits, days }) {
  const q = client || db;
  await q.query(
    `INSERT INTO check_credits (user_id, payment_id, source, credits, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
     ON CONFLICT (payment_id) WHERE payment_id IS NOT NULL DO NOTHING`,
    [userId, paymentId, source, credits, days]);
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
  if (UNLIMITED.has(tier)) return { unlimited: true, tier };
  /* Pack mode (migration 213): { packs, free_left, credits: { left, expires } } - and today/month kept in the old
     shape (left = everything they can still check) so older screens still read a number. */
  if (PACK_TIERS.has(tier) && await packsOn()) {
    const freeLimit = await settings.num('free_checks_lifetime', 1);
    const freeLeft = Math.max(0, freeLimit - await freeUsed(userId));
    const c = await creditsOf(userId);
    const all = freeLeft + c.left;
    return { tier, enforced: true, packs: true, free_left: freeLeft,
      credits: { left: c.left, expires: c.nextExpiry, last_expiry: c.lastExpiry },
      today: { used: 0, limit: all, left: all }, month: null };
  }
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
async function record(userId, regNo, { repeat = false, found = true, channel = null, q = null } = {}) {
  /* Pack mode: a check made on a credit uses it now - only when the vehicle was found (a "not found" costs no
     provider anything) - and is marked, so it is not mistaken for the free one. */
  let credit = false;
  if (q?.packs && q.credit && !repeat && found) credit = await consume(userId).catch(() => false);
  // channel 'web' marks a website check, so the website admin can count its own (2026-10-07).
  await db.query(
    `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, $2, $3)`,
    [userId, repeat || q?.owned ? 'vehicle_check_repeat' : 'vehicle_check',
     JSON.stringify({ reg_no: regNo, found, ...(channel ? { channel } : {}), ...(credit ? { credit: 'used' } : {}), ...(q?.owned ? { owned: true } : {}) })]);
  // The plain-words activity log (2026-10-08).
  try {
    const u = userId ? await db.one(`SELECT coalesce(display_name, wa_profile_name) AS name, mobile FROM users WHERE id = $1`, [userId]) : null;
    require('./activity').log('🔍', `Vehicle checked${repeat ? ' again' : ''} · ${regNo} · ${found ? 'found' : 'not found'}`,
      { who: require('./activity').who(u?.name, u?.mobile), detail: channel ? `on ${channel === 'web' ? 'the website' : channel}` : null });
  } catch { /* the log never stops a check */ }
}

module.exports = { check, record, tierOf, left, grant, creditsOf, packsOn };
