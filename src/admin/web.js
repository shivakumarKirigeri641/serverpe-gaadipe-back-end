/**
 * src/admin/web.js — THE WEBSITE ADMIN (user, 2026-10-07: "a new admin just
 * for the website and chat": visitors, sign-ins, the chat, Google and Meta ads,
 * free checks against paid reports). Read-only: every function here SELECTs.
 *
 *   overview({ range })        totals, the funnel, sources and a time series
 *   visitors({ range, ... })   website visitors, newest first, with their source
 *   trail(visitorId)           one visitor's pages and events
 *   customers({ range, q })    customers who signed in on the website
 *   freeChecks({ range })      the chat's checks without signing in
 *
 * WHERE EACH NUMBER COMES FROM
 *   visitors      events (channel web) — a browser's random id, never a person
 *   source        the visitor's FIRST touch (visitors.first_touch): google_ads,
 *                 meta_ads, google, social, direct … (events/track.js touchOf)
 *   chat opens    page views of /chat
 *   free checks   event_log chat_anon_check (site/chat.js)
 *   sign-ins      site_sign_ins 'signed_in'; NEW = that customer's first ever
 *   web checks    event_log vehicle_check(_repeat) tagged channel web
 *   paid          payments 'paid' started on the website (raw.channel = web)
 * A customer's source is the source of the earliest visitor linked to them.
 * Ranges are whole Indian days: today, 7d (today and the 6 before), 30d.
 */

const db = require('../db');

const RANGES = { today: 0, '7d': 6, '30d': 29 };
const rangeOf = (r) => (Object.prototype.hasOwnProperty.call(RANGES, r) ? r : 'today');
/* The start of the range: midnight IST, N days back. Passed to SQL as $1. */
const FROM = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - make_interval(days => $1::int)) AT TIME ZONE 'Asia/Kolkata'`;

const n = (v) => Number(v) || 0;
const SRC = `coalesce(nullif(v.first_touch->>'source', ''), 'direct')`;

async function overview({ range } = {}) {
  const r = rangeOf(range);
  const days = RANGES[r];

  const t = await db.one(
    `WITH seen AS (
       SELECT DISTINCT visitor_id FROM events
        WHERE channel = 'web' AND visitor_id IS NOT NULL AND occurred_at >= ${FROM})
     SELECT
       (SELECT count(*) FROM seen)                                                              AS visitors,
       (SELECT count(*) FROM visitors WHERE first_seen_at >= ${FROM})                          AS new_visitors,
       (SELECT count(DISTINCT visitor_id) FROM events
         WHERE channel = 'web' AND name = 'page_view' AND page LIKE '/chat%' AND occurred_at >= ${FROM}) AS chat_visitors,
       (SELECT count(*) FROM event_log WHERE kind = 'chat_anon_check' AND created_at >= ${FROM}) AS free_checks,
       (SELECT count(*) FROM event_log WHERE kind = 'chat_anon_check' AND created_at >= ${FROM}
                                         AND (detail->>'found')::boolean)                       AS free_found,
       (SELECT count(DISTINCT coalesce(nullif(detail->>'device', ''), detail->>'ip')) FROM event_log
         WHERE kind = 'chat_anon_check' AND created_at >= ${FROM})                              AS free_checkers,
       (SELECT count(*) FROM site_sign_ins WHERE event = 'code_requested' AND created_at >= ${FROM}) AS codes_requested,
       (SELECT count(*) FROM site_sign_ins WHERE event = 'signed_in' AND created_at >= ${FROM})  AS sign_ins,
       (SELECT count(DISTINCT user_id) FROM site_sign_ins WHERE event = 'signed_in' AND created_at >= ${FROM}) AS signed_in_customers,
       (SELECT count(*) FROM (SELECT user_id, min(created_at) AS first FROM site_sign_ins
                               WHERE event = 'signed_in' AND user_id IS NOT NULL GROUP BY user_id) f
         WHERE f.first >= ${FROM})                                                              AS new_customers,
       (SELECT count(*) FROM event_log WHERE kind IN ('vehicle_check', 'vehicle_check_repeat')
                                         AND detail->>'channel' = 'web' AND created_at >= ${FROM}) AS web_checks,
       (SELECT count(DISTINCT coalesce(payment_id::text, event_key)) FROM events
         WHERE channel = 'web' AND name = 'payment_page_viewed' AND occurred_at >= ${FROM})       AS pay_opened,
       (SELECT count(*) FROM payments WHERE status = 'paid' AND raw->>'channel' = 'web' AND coalesce(paid_at, created_at) >= ${FROM}) AS paid,
       (SELECT coalesce(sum(amount_paise), 0) FROM payments
         WHERE status = 'paid' AND raw->>'channel' = 'web' AND coalesce(paid_at, created_at) >= ${FROM}) AS revenue_paise,
       (SELECT count(*) FROM customer_push_subscriptions)                                      AS push_devices,
       (SELECT count(DISTINCT user_id) FROM customer_push_subscriptions)                       AS push_customers,
       (SELECT count(*) FROM site_sessions WHERE ended_at IS NULL AND last_used_at > now() - interval '15 minutes') AS online_now`,
    [days]);
  const totals = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, n(v)]));

  /* Each source: visitors in the range, and what the customers it brought did in the range. */
  const { rows: sources } = await db.query(
    `WITH seen AS (
       SELECT DISTINCT e.visitor_id FROM events e
        WHERE e.channel = 'web' AND e.visitor_id IS NOT NULL AND e.occurred_at >= ${FROM}),
     vis AS (
       SELECT ${SRC} AS source, count(*) AS visitors,
              count(*) FILTER (WHERE v.first_seen_at >= ${FROM}) AS new_visitors
         FROM seen s JOIN visitors v ON v.visitor_id = s.visitor_id GROUP BY 1),
     cust_src AS (
       SELECT DISTINCT ON (v.user_id) v.user_id, ${SRC} AS source
         FROM visitors v WHERE v.user_id IS NOT NULL ORDER BY v.user_id, v.first_seen_at),
     signed AS (
       SELECT coalesce(c.source, 'unknown') AS source, count(DISTINCT s.user_id) AS signed_in
         FROM site_sign_ins s LEFT JOIN cust_src c ON c.user_id = s.user_id
        WHERE s.event = 'signed_in' AND s.created_at >= ${FROM} GROUP BY 1),
     paid AS (
       SELECT coalesce(c.source, 'unknown') AS source, count(*) AS paid, count(DISTINCT p.user_id) AS payers,
              sum(p.amount_paise) AS revenue_paise
         FROM payments p LEFT JOIN cust_src c ON c.user_id = p.user_id
        WHERE p.status = 'paid' AND p.raw->>'channel' = 'web' AND coalesce(p.paid_at, p.created_at) >= ${FROM} GROUP BY 1)
     SELECT coalesce(vis.source, signed.source, paid.source) AS source,
            coalesce(vis.visitors, 0) AS visitors, coalesce(vis.new_visitors, 0) AS new_visitors,
            coalesce(signed.signed_in, 0) AS signed_in, coalesce(paid.paid, 0) AS paid,
            coalesce(paid.payers, 0) AS payers, coalesce(paid.revenue_paise, 0) AS revenue_paise
       FROM vis FULL JOIN signed ON signed.source = vis.source
                FULL JOIN paid ON paid.source = coalesce(vis.source, signed.source)
      ORDER BY 2 DESC, 4 DESC`,
    [days]);

  /* Hour by hour for today, day by day otherwise (IST). */
  const grain = r === 'today' ? 'hour' : 'day';
  const { rows: series } = await db.query(
    `WITH b AS (
       SELECT generate_series(date_trunc($2, ${FROM} AT TIME ZONE 'Asia/Kolkata'),
                              date_trunc($2, now() AT TIME ZONE 'Asia/Kolkata'),
                              ('1 ' || $2)::interval) AS at)
     SELECT to_char(b.at, CASE WHEN $2 = 'hour' THEN 'HH24:00' ELSE 'DD Mon' END) AS label,
       (SELECT count(DISTINCT visitor_id) FROM events
         WHERE channel = 'web' AND date_trunc($2, occurred_at AT TIME ZONE 'Asia/Kolkata') = b.at)  AS visitors,
       (SELECT count(*) FROM event_log
         WHERE kind = 'chat_anon_check' AND date_trunc($2, created_at AT TIME ZONE 'Asia/Kolkata') = b.at) AS free_checks,
       (SELECT count(*) FROM site_sign_ins
         WHERE event = 'signed_in' AND date_trunc($2, created_at AT TIME ZONE 'Asia/Kolkata') = b.at) AS sign_ins,
       (SELECT count(*) FROM payments
         WHERE status = 'paid' AND raw->>'channel' = 'web'
           AND date_trunc($2, coalesce(paid_at, created_at) AT TIME ZONE 'Asia/Kolkata') = b.at)    AS paid
       FROM b ORDER BY b.at`,
    [days, grain]);

  return {
    range: r, grain, totals,
    funnel: [
      { key: 'visitors', label: 'Visited the site', n: totals.visitors },
      { key: 'chat', label: 'Opened the chat', n: totals.chat_visitors },
      { key: 'free', label: 'Ran a free check', n: totals.free_checkers },
      { key: 'signed', label: 'Signed in', n: totals.signed_in_customers },
      { key: 'pay', label: 'Opened the ₹19 payment', n: totals.pay_opened },
      { key: 'paid', label: 'Paid', n: totals.paid },
    ],
    sources: sources.map((s) => ({ source: s.source, visitors: n(s.visitors), new_visitors: n(s.new_visitors),
      signed_in: n(s.signed_in), paid: n(s.paid), payers: n(s.payers), revenue_paise: n(s.revenue_paise) })),
    series: series.map((s) => ({ label: s.label, visitors: n(s.visitors), free_checks: n(s.free_checks),
      sign_ins: n(s.sign_ins), paid: n(s.paid) })),
  };
}

/** Website visitors seen in the range, most recent first. */
async function visitors({ range, source = '', q = '', limit = 100, offset = 0 } = {}) {
  const r = rangeOf(range);
  const term = String(q || '').trim().replace(/[%_]/g, '');
  const { rows } = await db.query(
    `WITH seen AS (
       SELECT visitor_id, max(occurred_at) AS last_at, count(*) FILTER (WHERE name = 'page_view') AS views,
              bool_or(page LIKE '/chat%') AS chat
         FROM events WHERE channel = 'web' AND visitor_id IS NOT NULL AND occurred_at >= ${FROM}
        GROUP BY visitor_id)
     SELECT v.visitor_id, v.first_seen_at, s.last_at, s.views, s.chat, ${SRC} AS source,
            coalesce(v.last_touch->>'campaign', v.first_touch->>'campaign') AS campaign,
            v.first_touch->>'landing' AS landing, v.device, v.place, v.user_id,
            u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
            (SELECT count(*) FROM payments p WHERE p.user_id = v.user_id AND p.status = 'paid') AS paid,
            count(*) OVER () AS total_rows
       FROM seen s JOIN visitors v ON v.visitor_id = s.visitor_id
       LEFT JOIN users u ON u.id = v.user_id
      WHERE ($2 = '' OR ${SRC} = $2)
        AND ($3 = '' OR u.mobile ILIKE '%' || $3 || '%' OR v.place->>'city' ILIKE '%' || $3 || '%'
             OR coalesce(u.display_name, u.wa_profile_name, '') ILIKE '%' || $3 || '%' OR v.visitor_id = $3)
      ORDER BY s.last_at DESC LIMIT $4 OFFSET $5`,
    [RANGES[r], String(source || ''), term, Math.min(200, Number(limit) || 100), Number(offset) || 0]);
  return {
    range: r, total: rows[0] ? n(rows[0].total_rows) : 0,
    rows: rows.map(({ total_rows, ...x }) => ({ ...x, views: n(x.views), paid: n(x.paid),
      user_id: x.user_id ? String(x.user_id) : null })),
  };
}

/** One visitor: their pages and events, oldest first. */
async function trail(visitorId) {
  const id = String(visitorId || '').slice(0, 64);
  const v = await db.one(
    `SELECT v.*, ${SRC} AS source, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name
       FROM visitors v LEFT JOIN users u ON u.id = v.user_id WHERE v.visitor_id = $1`, [id]);
  if (!v) return { visitor: null, rows: [] };
  const { rows } = await db.query(
    `SELECT occurred_at, name, page, source, campaign, reg_no, status, amount_paise,
            metadata->>'label' AS label, metadata->>'referrer' AS referrer
       FROM events WHERE visitor_id = $1 ORDER BY occurred_at DESC LIMIT 300`, [id]);
  return { visitor: { ...v, user_id: v.user_id ? String(v.user_id) : null }, rows: rows.reverse() };
}

/** Customers who signed in on the website, most recently active first. */
async function customers({ range, q = '', limit = 100, offset = 0 } = {}) {
  const r = rangeOf(range);
  const term = String(q || '').trim().replace(/[%_]/g, '');
  const { rows } = await db.query(
    `WITH active AS (
       SELECT user_id, min(created_at) AS first_at FROM site_sign_ins
        WHERE event = 'signed_in' AND user_id IS NOT NULL GROUP BY user_id),
     cust_src AS (
       SELECT DISTINCT ON (v.user_id) v.user_id, ${SRC} AS source, v.place
         FROM visitors v WHERE v.user_id IS NOT NULL ORDER BY v.user_id, v.first_seen_at)
     SELECT u.id AS user_id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.email,
            a.first_at, (a.first_at >= ${FROM}) AS is_new,
            (SELECT max(coalesce(last_used_at, created_at)) FROM site_sessions WHERE user_id = u.id) AS last_seen,
            (SELECT count(*) FROM site_sessions WHERE user_id = u.id AND ended_at IS NULL) AS open_sessions,
            coalesce(c.source, 'unknown') AS source, c.place,
            (SELECT count(*) FROM event_log WHERE user_id = u.id AND kind IN ('vehicle_check', 'vehicle_check_repeat')
                                              AND created_at >= ${FROM}) AS checks,
            (SELECT count(*) FROM payments WHERE user_id = u.id AND status = 'paid') AS paid,
            (SELECT coalesce(sum(amount_paise), 0) FROM payments WHERE user_id = u.id AND status = 'paid') AS revenue_paise,
            (SELECT count(*) FROM customer_push_subscriptions WHERE user_id = u.id) AS push_devices,
            count(*) OVER () AS total_rows
       FROM active a JOIN users u ON u.id = a.user_id
       LEFT JOIN cust_src c ON c.user_id = u.id
      WHERE (EXISTS (SELECT 1 FROM site_sessions s WHERE s.user_id = u.id
                      AND coalesce(s.last_used_at, s.created_at) >= ${FROM})
             OR a.first_at >= ${FROM})
        AND ($2 = '' OR u.mobile ILIKE '%' || $2 || '%' OR coalesce(u.display_name, u.wa_profile_name, '') ILIKE '%' || $2 || '%'
             OR coalesce(u.email, '') ILIKE '%' || $2 || '%')
      ORDER BY last_seen DESC NULLS LAST LIMIT $3 OFFSET $4`,
    [RANGES[r], term, Math.min(200, Number(limit) || 100), Number(offset) || 0]);
  return {
    range: r, total: rows[0] ? n(rows[0].total_rows) : 0,
    rows: rows.map(({ total_rows, ...x }) => ({ ...x, user_id: String(x.user_id), open_sessions: n(x.open_sessions),
      checks: n(x.checks), paid: n(x.paid), revenue_paise: n(x.revenue_paise), push_devices: n(x.push_devices) })),
  };
}

/** The chat's free checks without signing in. */
async function freeChecks({ range, limit = 200 } = {}) {
  const r = rangeOf(range);
  const { rows } = await db.query(
    `SELECT id, created_at, detail->>'reg_no' AS reg_no, (detail->>'found')::boolean AS found,
            left(coalesce(nullif(detail->>'device', ''), '—'), 8) AS device, left(detail->>'ip', 8) AS ip
       FROM event_log WHERE kind = 'chat_anon_check' AND created_at >= ${FROM}
      ORDER BY id DESC LIMIT $2`, [RANGES[r], Math.min(500, Number(limit) || 200)]);
  const s = await db.one(
    `SELECT count(*) AS checks, count(*) FILTER (WHERE (detail->>'found')::boolean) AS found,
            count(DISTINCT coalesce(nullif(detail->>'device', ''), detail->>'ip')) AS devices,
            count(DISTINCT detail->>'reg_no') AS vehicles
       FROM event_log WHERE kind = 'chat_anon_check' AND created_at >= ${FROM}`, [RANGES[r]]);
  /* Devices that ran a free check and then signed in — the chat doing its job. */
  const conv = await db.one(
    `SELECT count(DISTINCT e.detail->>'device') AS n
       FROM event_log e JOIN site_sign_ins s ON s.device_id = e.detail->>'device' AND s.event = 'signed_in'
                                           AND s.created_at >= e.created_at
      WHERE e.kind = 'chat_anon_check' AND e.created_at >= ${FROM} AND coalesce(e.detail->>'device', '') <> ''`,
    [RANGES[r]]);
  return {
    range: r,
    summary: { checks: n(s.checks), found: n(s.found), devices: n(s.devices), vehicles: n(s.vehicles), then_signed_in: n(conv.n) },
    rows: rows.map((x) => ({ ...x, id: String(x.id) })),
  };
}

module.exports = { overview, visitors, trail, customers, freeChecks, _test: { rangeOf } };
