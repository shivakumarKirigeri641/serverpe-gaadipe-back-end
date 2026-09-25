/**
 * src/admin/dataQuality.js — how complete and reliable the vehicle data is
 * (user, 2026-09-25, operations module phase 4).
 * ---------------------------------------------------------------------------
 *   overview(q)
 *     availability  of every vehicle record GaadiPe holds, the share where the
 *                   records API returned insurance, PUC, tax, permit, a
 *                   challan check, a financier field and a blacklist field
 *     problems      empty and malformed responses, rejected requests, stale
 *                   records past their refresh date, stored values that
 *                   disagree with the provider's latest answer, duplicate
 *                   registrations
 *     trend         the same availability, day by day, from the reports issued
 *                   each day (each report keeps the record it was built from)
 *
 * "Available" means the provider returned a value — not that the document is
 * valid. A permit is often legitimately absent (private vehicles have none),
 * so its percentage is read with that in mind; the screen says so.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const command = require('./command');

const FIELDS = [
  ['insurance', 'Insurance', `nullif(btrim(rc->>'insurance_upto'), '') IS NOT NULL`],
  ['puc', 'PUC', `nullif(btrim(rc->>'pucc_upto'), '') IS NOT NULL`],
  ['tax', 'Road tax', `nullif(btrim(rc->>'tax_upto'), '') IS NOT NULL`],
  ['permit', 'Permit', `nullif(btrim(rc->>'permit_upto'), '') IS NOT NULL`],
  ['fitness', 'Fitness', `nullif(btrim(rc->>'fitness_upto'), '') IS NOT NULL`],
  ['loan', 'Financier field', `rc ? 'financer'`],
  ['blacklist', 'Blacklist field', `rc ? 'blacklist_status'`],
];

async function overview(q = {}) {
  const r = command.resolve({ range: q.range || '30d', from: q.from, to: q.to, compare: 'none' });
  const avail = FIELDS.map(([k, , expr]) => `count(*) FILTER (WHERE ${expr})::int AS ${k}`).join(', ');
  const [cur, challan, api, stale, conflicts, dupes, trend] = await Promise.all([
    db.one(`SELECT count(*)::int AS total, ${avail}
              FROM (SELECT s.data AS rc FROM vehicle_snapshots s WHERE s.dataset = 'rc') x`),
    db.one(`SELECT (SELECT count(*) FROM vehicles)::int AS vehicles,
                   (SELECT count(DISTINCT vehicle_id) FROM vehicle_snapshots WHERE dataset = 'challan')::int AS with_challan`),
    db.one(`SELECT count(*) FILTER (WHERE NOT cache_hit)::int AS live_calls,
                   count(*) FILTER (WHERE error_code = 'EMPTY')::int AS empty,
                   count(*) FILTER (WHERE error_code = 'BAD_JSON')::int AS malformed,
                   count(*) FILTER (WHERE outcome = 'REJECTED')::int AS rejected,
                   count(*) FILTER (WHERE outcome = 'NOT_FOUND')::int AS not_found,
                   count(*) FILTER (WHERE NOT ok AND coalesce(error_code, '') NOT IN ('EMPTY', 'BAD_JSON') AND outcome <> 'NOT_FOUND')::int AS other_failures
              FROM api_calls WHERE created_at >= $1 AND created_at < $2`, [r.from, r.to]),
    db.one(`SELECT count(*) FILTER (WHERE expires_at < now())::int AS stale, count(*)::int AS total,
                   count(*) FILTER (WHERE fetched_at < now() - interval '30 days')::int AS older_30d
              FROM vehicle_snapshots`),
    // The vehicles row keeps the dates it was last given; the snapshot is the provider's latest answer.
    db.query(`SELECT v.reg_no,
                     array_remove(ARRAY[
                       CASE WHEN v.insurance_upto IS DISTINCT FROM nullif(s.data->>'insurance_upto', '')::date THEN 'insurance' END,
                       CASE WHEN v.pucc_upto IS DISTINCT FROM nullif(s.data->>'pucc_upto', '')::date THEN 'puc' END,
                       CASE WHEN v.tax_upto IS DISTINCT FROM (CASE WHEN s.data->>'tax_upto' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (s.data->>'tax_upto')::date END) THEN 'tax' END
                     ], NULL) AS fields
                FROM vehicles v JOIN vehicle_snapshots s ON s.vehicle_id = v.id AND s.dataset = 'rc'`),
    db.one(`SELECT count(*)::int AS n FROM (SELECT upper(regexp_replace(reg_no, '[^A-Za-z0-9]', '', 'g')) k FROM vehicles GROUP BY 1 HAVING count(*) > 1) d`),
    db.query(`SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, count(*)::int AS total, ${avail}
                FROM (SELECT created_at, snapshot->'rc' AS rc FROM vehicle_reports WHERE created_at >= $1 AND created_at < $2 AND snapshot ? 'rc') x
               GROUP BY 1 ORDER BY 1`, [r.from, r.to]),
  ]);
  const pc = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  const conflicted = conflicts.rows.filter((x) => x.fields.length);
  return {
    range: { label: r.label },
    records: cur.total,
    availability: [
      ...FIELDS.map(([k, label]) => ({ key: k, label, n: cur[k], of: cur.total, pct: pc(cur[k], cur.total) })),
      { key: 'challan', label: 'Challan check', n: challan.with_challan, of: challan.vehicles, pct: pc(challan.with_challan, challan.vehicles) },
    ],
    problems: [
      { key: 'empty', label: 'Null / empty responses', n: api.empty, of: api.live_calls, note: 'The records API answered with no body.' },
      { key: 'malformed', label: 'Malformed responses', n: api.malformed, of: api.live_calls, note: 'The answer was not valid JSON — a parsing failure.' },
      { key: 'rejected', label: 'Rejected requests', n: api.rejected, of: api.live_calls, note: 'The provider refused the request (400).' },
      { key: 'not_found', label: 'Vehicle not found', n: api.not_found, of: api.live_calls, note: 'A clean “no such vehicle” — not an error in the data.' },
      { key: 'other', label: 'Other failures', n: api.other_failures, of: api.live_calls, note: 'Timeouts, upstream down, unauthenticated…' },
      { key: 'stale', label: 'Stale records', n: stale.stale, of: stale.total, note: 'Stored answers past their refresh date (shown as cached, never as current).' },
      { key: 'conflicting', label: 'Conflicting values', n: conflicted.length, of: conflicts.rows.length, note: 'The vehicle’s stored dates differ from the provider’s latest answer.', rows: conflicted.slice(0, 50) },
      { key: 'duplicates', label: 'Duplicate registrations', n: dupes.n, of: challan.vehicles, note: 'Registrations are normalised (KA-01 AB 1234 = KA01AB1234) and unique.' },
    ].map((p) => ({ ...p, pct: pc(p.n, p.of) })),
    trend: trend.rows.map((t) => ({ day: t.day, total: t.total, ...Object.fromEntries(FIELDS.map(([k]) => [k, pc(t[k], t.total)])) })),
    notes: {
      available: '“Available” means the provider returned a value, not that the document is valid.',
      permit: 'Private vehicles usually have no permit, so a low permit share is expected.',
      trend: 'Day by day from the reports issued that day — each report keeps the record it was built from.',
    },
  };
}

module.exports = { overview };
