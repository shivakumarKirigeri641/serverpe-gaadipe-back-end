/**
 * src/admin/apiMonitor.js — the Government-records API, call by call (user,
 * 2026-09-25, command center phase 5).
 * ---------------------------------------------------------------------------
 *   summary(range)  per dataset (rc, challan, fastag, and cached answers):
 *                   calls, found, failed, timeouts, cache hits, average and
 *                   95th-percentile time, cost, cost per paid report, and the
 *                   last success and failure with its error; calls by hour of
 *                   day and by day.
 *   log(range, …)   the calls themselves, filterable.
 *
 * Read from api_calls, which vehicle/store.js writes for every call — a cached
 * answer included, since the cache hit rate is what keeps the cost down.
 * WhatsApp's and Razorpay's health are on their own pages: their failures
 * arrive as receipts and webhooks, not as calls we time.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const command = require('./command');

const TIMEOUT = `(a.error_code ILIKE '%timeout%' OR a.error_code ILIKE '%ETIMEDOUT%' OR a.outcome ILIKE '%timeout%' OR a.error_message ILIKE '%timed out%')`;

async function summary(q = {}) {
  const r = command.resolve(q);
  const [byDataset, byHour, byDay, paid] = await Promise.all([
    db.query(
      `SELECT a.dataset,
              count(*)::int AS calls,
              count(*) FILTER (WHERE a.ok AND NOT a.cache_hit)::int AS found,
              count(*) FILTER (WHERE NOT a.ok)::int AS failed,
              count(*) FILTER (WHERE ${TIMEOUT})::int AS timeouts,
              count(*) FILTER (WHERE a.cache_hit)::int AS cached,
              round(avg(a.duration_ms) FILTER (WHERE NOT a.cache_hit))::int AS avg_ms,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY a.duration_ms) FILTER (WHERE NOT a.cache_hit))::int AS p95_ms,
              max(a.duration_ms)::int AS max_ms,
              coalesce(sum(a.cost_paise), 0)::int AS cost_paise,
              max(a.created_at) FILTER (WHERE a.ok) AS last_ok,
              max(a.created_at) FILTER (WHERE NOT a.ok) AS last_failure,
              (SELECT coalesce(b.error_message, b.error_code, b.outcome) FROM api_calls b
                WHERE b.dataset = a.dataset AND NOT b.ok AND b.created_at >= $1 AND b.created_at < $2
                ORDER BY b.id DESC LIMIT 1) AS last_error
         FROM api_calls a WHERE a.created_at >= $1 AND a.created_at < $2
        GROUP BY a.dataset ORDER BY calls DESC`, [r.from, r.to]),
    db.query(
      `SELECT extract(hour FROM a.created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
              count(*)::int AS calls, count(*) FILTER (WHERE NOT a.ok)::int AS failed
         FROM api_calls a WHERE a.created_at >= $1 AND a.created_at < $2 GROUP BY 1 ORDER BY 1`, [r.from, r.to]),
    db.query(
      `SELECT to_char(a.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
              count(*) FILTER (WHERE a.ok AND NOT a.cache_hit)::int AS found,
              count(*) FILTER (WHERE a.cache_hit)::int AS cached,
              count(*) FILTER (WHERE NOT a.ok)::int AS failed,
              round(avg(a.duration_ms) FILTER (WHERE NOT a.cache_hit))::int AS avg_ms
         FROM api_calls a WHERE a.created_at >= $1 AND a.created_at < $2 GROUP BY 1 ORDER BY 1`, [r.from, r.to]),
    db.one(`SELECT count(*)::int AS n FROM payments WHERE status = 'paid' AND paid_at >= $1 AND paid_at < $2`, [r.from, r.to]),
  ]);
  const t = byDataset.rows.reduce((s, d) => ({
    calls: s.calls + d.calls, failed: s.failed + d.failed, timeouts: s.timeouts + d.timeouts,
    cached: s.cached + d.cached, cost_paise: s.cost_paise + d.cost_paise,
  }), { calls: 0, failed: 0, timeouts: 0, cached: 0, cost_paise: 0 });
  const overall = await db.one(
    `SELECT round(avg(duration_ms) FILTER (WHERE NOT cache_hit))::int AS avg_ms,
            round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE NOT cache_hit))::int AS p95_ms
       FROM api_calls WHERE created_at >= $1 AND created_at < $2`, [r.from, r.to]);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    range: { label: r.label, from: r.from, to: r.to },
    totals: {
      ...t, ...overall,
      error_pct: pct(t.failed, t.calls), cache_pct: pct(t.cached, t.calls),
      cost_per_paid_paise: paid.n ? Math.round(t.cost_paise / paid.n) : null, paid_reports: paid.n,
      status: !t.calls ? 'idle' : pct(t.failed, t.calls) >= 20 ? 'down' : pct(t.failed, t.calls) >= 5 || (overall.p95_ms || 0) > 8000 ? 'degraded' : 'operational',
    },
    by_dataset: byDataset.rows,
    by_hour: Array.from({ length: 24 }, (_, h) => ({ hour: h, ...(byHour.rows.find((x) => x.hour === h) || { calls: 0, failed: 0 }) })),
    by_day: byDay.rows,
  };
}

const RESULT = { ok: `a.ok AND NOT a.cache_hit`, failed: `NOT a.ok`, cached: `a.cache_hit`, timeout: TIMEOUT };

async function log(q = {}) {
  const r = command.resolve(q);
  const plate = String(q.q || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const { rows } = await db.query(
    `SELECT a.id, a.created_at, a.dataset, a.provider_path, a.reg_no, a.cache_hit, a.ok, a.outcome, a.http_status,
            a.error_code, a.error_message, a.duration_ms, a.cost_paise, a.user_id,
            count(*) OVER () AS total
       FROM api_calls a
      WHERE a.created_at >= $1 AND a.created_at < $2
        AND ($3 = '' OR a.dataset = $3)
        AND (${RESULT[q.result] || 'true'})
        AND ($4 = '' OR a.reg_no LIKE '%' || $4 || '%')
      ORDER BY a.id DESC LIMIT $5 OFFSET $6`,
    [r.from, r.to, /^[a-z_]{1,20}$/.test(String(q.dataset || '')) ? q.dataset : '', plate,
     Math.min(200, Number(q.limit) || 50), Number(q.offset) || 0]);
  return { total: rows[0] ? Number(rows[0].total) : 0, rows: rows.map(({ total, ...x }) => ({ ...x, id: String(x.id) })) };
}

module.exports = { summary, log };
