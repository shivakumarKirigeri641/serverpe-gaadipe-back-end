/**
 * src/admin/analytics.js — MINUTE-BY-MINUTE ANALYTICS AND THE LIVE FUNNEL
 * (user, 2026-10-07; spec §5, §21–23, §44, §53, §116).
 *
 *   rollup(from, to)        writes analytics_minute rows for [from, to) from the
 *                           tables GaadiPe already keeps (jobs/analyticsRollup.js)
 *   series({ range })       figures per bucket: a minute for 15 min – 3 h, five
 *                           minutes for today / yesterday, an hour for 7 days, a
 *                           day (Indian) for 30 days; the unfinished bucket flagged
 *   summary({ range })      the period's totals beside the previous period's
 *   funnel({ range })       visits → searched → saw a vehicle → tapped Full report
 *                           → payment started → paid → report, each with its
 *                           count, share, drop-off and average time to the next
 *   funnelPeople(stage)     the visits that reached a stage (and stopped there)
 */

const db = require('../db');

const n = (v) => Number(v) || 0;
/* A website payment (a payment's own record of where it was made). */
const WEB_PAY = `coalesce(payments.raw->>'channel', payments.raw->'paid_from'->>'channel', 'whatsapp') = 'web'`;
const METRICS = ['visitors', 'active_sessions', 'page_views', 'interactions', 'searches', 'free_checks', 'web_checks', 'otp_requests',
  'otp_success', 'otp_failed', 'pay_attempts', 'payments', 'revenue_paise', 'reports', 'api_calls', 'api_failures', 'api_ms_sum', 'errors'];

/** Compute and store every minute in [from, to). Re-running a minute replaces it (late events). */
async function rollup(from, to) {
  await db.query(
    `WITH b AS (SELECT generate_series(date_trunc('minute', $1::timestamptz), date_trunc('minute', $2::timestamptz - interval '1 second'), interval '1 minute') AS m),
     ev AS (SELECT date_trunc('minute', occurred_at) AS m,
                   count(DISTINCT visitor_id) FILTER (WHERE channel = 'web') AS visitors,
                   count(*) FILTER (WHERE name = 'page_view') AS page_views,
                   count(*) FILTER (WHERE name = 'interaction') AS interactions,
                   count(*) FILTER (WHERE name = 'interaction' AND metadata->>'kind' = 'search') AS searches,
                   count(*) FILTER (WHERE name = 'interaction' AND metadata->>'kind' = 'error') AS site_errors
              FROM events WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY 1),
     el AS (SELECT date_trunc('minute', created_at) AS m,
                   count(*) FILTER (WHERE kind = 'chat_anon_check') AS free_checks,
                   count(*) FILTER (WHERE kind IN ('vehicle_check', 'vehicle_check_repeat') AND detail->>'channel' = 'web') AS web_checks
              FROM event_log WHERE created_at >= $1 AND created_at < $2
               AND kind IN ('chat_anon_check', 'vehicle_check', 'vehicle_check_repeat') GROUP BY 1),
     si AS (SELECT date_trunc('minute', created_at) AS m,
                   count(*) FILTER (WHERE event = 'code_requested') AS otp_requests,
                   count(*) FILTER (WHERE event = 'signed_in') AS otp_success,
                   count(*) FILTER (WHERE event IN ('sign_in_failed', 'code_refused')) AS otp_failed
              FROM site_sign_ins WHERE created_at >= $1 AND created_at < $2 GROUP BY 1),
     -- The website's payments and reports only (2026-10-07: every comparison is the website's).
     pa AS (SELECT date_trunc('minute', created_at) AS m, count(*) AS pay_attempts FROM payments
             WHERE created_at >= $1 AND created_at < $2 AND ${WEB_PAY} GROUP BY 1),
     pp AS (SELECT date_trunc('minute', paid_at) AS m, count(*) AS payments, sum(amount_paise) AS revenue_paise
              FROM payments WHERE status = 'paid' AND paid_at >= $1 AND paid_at < $2 AND ${WEB_PAY} GROUP BY 1),
     rp AS (SELECT date_trunc('minute', r.created_at) AS m, count(*) AS reports FROM vehicle_reports r
              JOIN payments payments ON payments.id = r.payment_id
             WHERE r.created_at >= $1 AND r.created_at < $2 AND ${WEB_PAY} GROUP BY 1),
     ap AS (SELECT date_trunc('minute', created_at) AS m, count(*) AS api_calls, count(*) FILTER (WHERE NOT ok) AS api_failures,
                   coalesce(sum(duration_ms) FILTER (WHERE NOT cache_hit), 0) AS api_ms_sum
              FROM api_calls WHERE created_at >= $1 AND created_at < $2 GROUP BY 1),
     ws AS (SELECT b.m, count(w.session_id) AS active_sessions FROM b
              JOIN web_sessions w ON w.started_at < b.m + interval '1 minute' AND w.last_seen_at >= b.m GROUP BY 1)
     INSERT INTO analytics_minute AS a (bucket, visitors, active_sessions, page_views, interactions, searches, free_checks, web_checks,
                                        otp_requests, otp_success, otp_failed, pay_attempts, payments, revenue_paise, reports,
                                        api_calls, api_failures, api_ms_sum, errors, computed_at)
     SELECT b.m, coalesce(ev.visitors, 0), coalesce(ws.active_sessions, 0), coalesce(ev.page_views, 0), coalesce(ev.interactions, 0),
            coalesce(ev.searches, 0), coalesce(el.free_checks, 0), coalesce(el.web_checks, 0),
            coalesce(si.otp_requests, 0), coalesce(si.otp_success, 0), coalesce(si.otp_failed, 0),
            coalesce(pa.pay_attempts, 0), coalesce(pp.payments, 0), coalesce(pp.revenue_paise, 0), coalesce(rp.reports, 0),
            coalesce(ap.api_calls, 0), coalesce(ap.api_failures, 0), coalesce(ap.api_ms_sum, 0),
            coalesce(ev.site_errors, 0) + coalesce(si.otp_failed, 0) + coalesce(ap.api_failures, 0), now()
       FROM b LEFT JOIN ev ON ev.m = b.m LEFT JOIN el ON el.m = b.m LEFT JOIN si ON si.m = b.m LEFT JOIN pa ON pa.m = b.m
       LEFT JOIN pp ON pp.m = b.m LEFT JOIN rp ON rp.m = b.m LEFT JOIN ap ON ap.m = b.m LEFT JOIN ws ON ws.m = b.m
     ON CONFLICT (bucket) DO UPDATE SET ${METRICS.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, computed_at = now()`,
    [from, to]);
}

/* The windows a chart can show, and the bucket each uses. */
const RANGES = {
  '15m': { back: `now() - interval '15 minutes'`, step: 60 },
  '30m': { back: `now() - interval '30 minutes'`, step: 60 },
  '1h': { back: `now() - interval '1 hour'`, step: 60 },
  '3h': { back: `now() - interval '3 hours'`, step: 60 },
  today: { back: `date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`, step: 300 },
  yesterday: { back: `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - interval '1 day') AT TIME ZONE 'Asia/Kolkata'`,
    until: `date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`, step: 300 },
  '7d': { back: `now() - interval '7 days'`, step: 3600 },
  '30d': { back: `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - interval '29 days') AT TIME ZONE 'Asia/Kolkata'`, step: 86400, ist: true },
};

async function series({ range = '1h' } = {}) {
  const R = RANGES[range] || RANGES['1h'];
  // The last few minutes are written first, so the chart is current to the minute.
  await rollup(new Date(Date.now() - 3 * 60000), new Date(Date.now() + 60000)).catch(() => {});
  const bucketExpr = R.ist
    ? `(date_trunc('day', bucket AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`
    : `to_timestamp(floor(extract(epoch FROM bucket) / ${R.step}) * ${R.step})`;
  const { rows } = await db.query(
    `WITH r AS (SELECT ${R.back} AS a, ${R.until || 'now()'} AS z),
     agg AS (SELECT ${bucketExpr} AS t, ${METRICS.filter((m) => m !== 'visitors' && m !== 'active_sessions').map((m) => `sum(${m}) AS ${m}`).join(', ')},
                    max(active_sessions) AS active_sessions
               FROM analytics_minute, r WHERE bucket >= r.a AND bucket < r.z GROUP BY 1),
     vis AS (SELECT ${bucketExpr.replace(/bucket/g, 'occurred_at')} AS t, count(DISTINCT visitor_id) AS visitors
               FROM events, r WHERE channel = 'web' AND occurred_at >= r.a AND occurred_at < r.z GROUP BY 1),
     grid AS (SELECT generate_series(${R.ist ? `(SELECT a FROM r)` : `to_timestamp(floor(extract(epoch FROM (SELECT a FROM r)) / ${R.step}) * ${R.step})`},
                                     (SELECT z FROM r) - interval '1 second', interval '${R.step} seconds') AS t)
     SELECT grid.t, coalesce(vis.visitors, 0) AS visitors, ${METRICS.filter((m) => m !== 'visitors').map((m) => `coalesce(agg.${m}, 0) AS ${m}`).join(', ')}
       FROM grid LEFT JOIN agg ON agg.t = grid.t LEFT JOIN vis ON vis.t = grid.t ORDER BY grid.t`);
  const nowMs = Date.now();
  return {
    range, step: R.step,
    rows: rows.map((r) => {
      const o = { t: r.t, live: new Date(r.t).getTime() + R.step * 1000 > nowMs };
      for (const m of METRICS) o[m] = n(r[m]);
      o.api_avg_ms = o.api_calls ? Math.round(o.api_ms_sum / o.api_calls) : null;
      return o;
    }),
  };
}

/* The period's totals and the previous period's (spec §5: % change). */
const PERIODS = {
  today: [`date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`, `now()`],
  yesterday: [`(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - interval '1 day') AT TIME ZONE 'Asia/Kolkata'`, `date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`],
  '7d': [`now() - interval '7 days'`, `now()`],
  '30d': [`now() - interval '30 days'`, `now()`],
};
async function totals(a, z) {
  const r = await db.one(
    `SELECT ${METRICS.filter((m) => !['visitors', 'active_sessions'].includes(m)).map((m) => `coalesce(sum(${m}), 0) AS ${m}`).join(', ')},
            (SELECT count(DISTINCT visitor_id) FROM events WHERE channel = 'web' AND occurred_at >= $1 AND occurred_at < $2) AS visitors,
            (SELECT count(*) FROM users WHERE created_at >= $1 AND created_at < $2) AS new_users
       FROM analytics_minute WHERE bucket >= $1 AND bucket < $2`, [a, z]);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, n(v)]));
}
async function summary({ range = 'today' } = {}) {
  const [a, z] = PERIODS[range] || PERIODS.today;
  const b = await db.one(`SELECT ${a} AS a, ${z} AS z`);
  const span = new Date(b.z) - new Date(b.a);
  // "Today so far" is compared with yesterday up to the same time of day.
  const prevA = new Date(new Date(b.a).getTime() - (range === 'today' ? 86400e3 : span));
  const prevZ = new Date(prevA.getTime() + span);
  await rollup(new Date(Date.now() - 3 * 60000), new Date(Date.now() + 60000)).catch(() => {});
  const [cur, prev] = await Promise.all([totals(b.a, b.z), totals(prevA, prevZ)]);
  const change = Object.fromEntries(Object.keys(cur).map((k) => [k, prev[k] ? Math.round((100 * (cur[k] - prev[k])) / prev[k]) : null]));
  return { range, from: b.a, to: b.z, prev_from: prevA, prev_to: prevZ, current: cur, previous: prev, change };
}

/* ── the funnel ── */
const STAGES = [
  ['visited', 'Visited'], ['searched', 'Searched a vehicle'], ['saw', 'Saw the vehicle'], ['cta', 'Tapped Full report'],
  ['pay_started', 'Payment started'], ['paid', 'Paid'], ['report', 'Report generated'],
];
async function perVisit({ range = 'today', from = null, to = null } = {}) {
  // Explicit dates (the Command Center's periods) or a named range.
  const [a, z] = from && to ? ['$1::timestamptz', '$2::timestamptz'] : (PERIODS[range] || PERIODS.today);
  const { rows } = await db.query(
    `WITH s AS (SELECT w.session_id, w.user_id, w.started_at, w.last_seen_at, w.source, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name
                  FROM web_sessions w LEFT JOIN users u ON u.id = w.user_id WHERE w.started_at >= ${a} AND w.started_at < ${z}),
     e AS (SELECT session_id,
                  min(occurred_at) FILTER (WHERE name = 'interaction' AND metadata->>'kind' = 'search') AS searched,
                  min(occurred_at) FILTER (WHERE name = 'interaction' AND metadata->>'kind' = 'view') AS saw,
                  min(occurred_at) FILTER (WHERE name = 'interaction' AND (metadata->>'label' ILIKE '%full report%' OR metadata->>'step' = 'paying')) AS cta
             FROM events WHERE session_id IN (SELECT session_id FROM s) GROUP BY 1)
     SELECT s.*, e.searched, e.saw, e.cta,
            (SELECT min(p.created_at) FROM payments p WHERE p.user_id = s.user_id AND p.created_at BETWEEN s.started_at AND s.last_seen_at + interval '30 minutes') AS pay_started,
            (SELECT min(p.paid_at) FROM payments p WHERE p.user_id = s.user_id AND p.status = 'paid' AND p.paid_at BETWEEN s.started_at AND s.last_seen_at + interval '30 minutes') AS paid,
            (SELECT min(r.created_at) FROM vehicle_reports r WHERE r.user_id = s.user_id AND r.created_at BETWEEN s.started_at AND s.last_seen_at + interval '30 minutes') AS report
       FROM s LEFT JOIN e ON e.session_id = s.session_id ORDER BY s.started_at DESC`, from && to ? [from, to] : []);
  // A later stage implies the earlier ones (a payment without a recorded search still searched).
  return rows.map((r) => {
    const at = { visited: r.started_at, searched: r.searched, saw: r.saw, cta: r.cta, pay_started: r.pay_started, paid: r.paid, report: r.report };
    for (let i = STAGES.length - 2; i >= 1; i -= 1) if (!at[STAGES[i][0]] && at[STAGES[i + 1][0]]) at[STAGES[i][0]] = at[STAGES[i + 1][0]];
    return { ...r, user_id: r.user_id ? String(r.user_id) : null, at };
  });
}
async function funnel({ range = 'today' } = {}) {
  const visits = await perVisit({ range });
  const total = visits.length;
  const out = STAGES.map(([key, label], i) => {
    const reached = visits.filter((v) => v.at[key]);
    const next = STAGES[i + 1]?.[0];
    const both = next ? reached.filter((v) => v.at[next]) : [];
    const avg = both.length ? Math.round(both.reduce((s, v) => s + (new Date(v.at[next]) - new Date(v.at[key])) / 1000, 0) / both.length) : null;
    return { key, label, count: reached.length, pct_of_visits: total ? Math.round((100 * reached.length) / total) : 0,
      to_next_pct: next && reached.length ? Math.round((100 * both.length) / reached.length) : null,
      dropped: next ? reached.length - both.length : null, avg_seconds_to_next: avg };
  });
  return { range, visits: total, stages: out };
}
async function funnelPeople({ range = 'today', stage = 'visited', stopped = false } = {}) {
  const i = STAGES.findIndex(([k]) => k === stage);
  if (i < 0) return { rows: [] };
  const next = STAGES[i + 1]?.[0];
  const rows = (await perVisit({ range })).filter((v) => v.at[stage] && (!stopped || !next || !v.at[next]));
  return { stage, stopped, rows: rows.slice(0, 200).map((v) => ({ session_id: v.session_id, user_id: v.user_id, mobile: v.mobile, name: v.name,
    started_at: v.started_at, source: v.source, reached_at: v.at[stage], last_stage: [...STAGES].reverse().find(([k]) => v.at[k])?.[1] })) };
}

/* RETENTION (spec §42): each kind of detail kept only as long as its setting says. */
async function prune() {
  const s = require('../util/settings');
  const days = n(await s.num('analytics_minute_retention_days', 35)) || 35;
  await db.query(`DELETE FROM analytics_minute WHERE bucket < now() - make_interval(days => $1)`, [days]);
  const visits = n(await s.num('web_session_retention_days', 180)) || 180;
  await db.query(`DELETE FROM web_sessions WHERE last_seen_at < now() - make_interval(days => $1)`, [visits]);
  const taps = n(await s.num('web_interaction_retention_days', 90)) || 90;
  await db.query(`DELETE FROM events WHERE name = 'interaction' AND occurred_at < now() - make_interval(days => $1)`, [taps]);
}

module.exports = { rollup, series, summary, funnel, funnelPeople, perVisit, prune, METRICS, STAGES };
