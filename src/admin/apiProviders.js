/**
 * src/admin/apiProviders.js — each records-API provider and operation side
 * by side (user, 2026-09-25, operations module phase 4).
 *
 * GaadiPe reaches the Government records through ULIP; its providers are the
 * services behind it (VAHAN for the RC, ECHALLAN, FASTAG), each with its
 * operations (VAHAN/04 …). Per provider and per operation: calls, success,
 * failure, timeouts, retries, average and 95th-percentile latency, cost and
 * cost per successful lookup, error rate. Filterable by period, operation,
 * vehicle type and state. Cache hits are shown apart — they are not calls
 * to the provider. No credential is ever read here.
 */

const db = require('../db');
const command = require('./command');

async function overview(q = {}) {
  const r = command.resolve({ range: q.range || '7d', from: q.from, to: q.to, compare: 'none' });
  const args = [r.from, r.to]; const w = ['a.created_at >= $1', 'a.created_at < $2'];
  const bind = (v) => { args.push(v); return `$${args.length}`; };
  if (q.operation) w.push(`a.provider_path = ${bind(String(q.operation))}`);
  if (q.state) w.push(`upper(substring(a.reg_no from 1 for 2)) = ${bind(String(q.state).toUpperCase().slice(0, 2))}`);
  if (q.vclass) w.push(`v.vehicle_class ILIKE ${bind(`%${String(q.vclass)}%`)}`);
  const agg = `count(*) FILTER (WHERE NOT a.cache_hit)::int AS calls,
               count(*) FILTER (WHERE a.cache_hit)::int AS cached,
               count(*) FILTER (WHERE NOT a.cache_hit AND a.ok)::int AS success,
               count(*) FILTER (WHERE NOT a.cache_hit AND NOT a.ok)::int AS failure,
               count(*) FILTER (WHERE NOT a.cache_hit AND (a.error_code ILIKE '%timeout%' OR a.error_code IN ('ETIMEDOUT', 'ABORT', 'TimeoutError')
                                OR a.error_message ILIKE '%timed out%'))::int AS timeouts,
               count(*) FILTER (WHERE NOT a.cache_hit AND a.outcome = 'RETRY')::int AS retries,
               round(avg(a.duration_ms) FILTER (WHERE NOT a.cache_hit))::int AS avg_ms,
               round(percentile_cont(0.95) WITHIN GROUP (ORDER BY a.duration_ms) FILTER (WHERE NOT a.cache_hit))::int AS p95_ms,
               coalesce(sum(a.cost_paise), 0)::int AS cost_paise`;
  const from = `FROM api_calls a LEFT JOIN vehicles v ON v.reg_no = a.reg_no WHERE ${w.join(' AND ')}`;
  const [byProvider, byOperation, ops] = await Promise.all([
    db.query(`SELECT coalesce(split_part(a.provider_path, '/', 1), 'Not recorded') AS provider, ${agg} ${from} GROUP BY 1 ORDER BY 2 DESC`, args),
    db.query(`SELECT coalesce(a.provider_path, a.dataset) AS operation, a.dataset, ${agg} ${from} GROUP BY 1, 2 ORDER BY 3 DESC`, args),
    db.query(`SELECT DISTINCT provider_path FROM api_calls WHERE provider_path IS NOT NULL ORDER BY 1`),
  ]);
  const shape = (x) => ({
    ...x, success_pct: x.calls ? Math.round((x.success / x.calls) * 1000) / 10 : null,
    error_pct: x.calls ? Math.round((x.failure / x.calls) * 1000) / 10 : null,
    cost_per_success_paise: x.success ? Math.round(x.cost_paise / x.success) : null,
  });
  return {
    range: { label: r.label },
    providers: byProvider.rows.map(shape), operations: byOperation.rows.map(shape),
    filters: { operations: ops.rows.map((o) => o.provider_path) },
    notes: {
      retries: 'Retry: an answer the client marks to try again (upstream down, unauthenticated, empty). Each attempt is its own call.',
      cached: 'Cached answers are served from GaadiPe’s store and cost nothing; they are not calls to the provider.',
    },
  };
}

module.exports = { overview };
