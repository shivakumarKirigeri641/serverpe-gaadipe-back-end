/**
 * src/admin/lookups.js — every vehicle lookup, and what they add up to
 * (user, 2026-09-25, command center phase 4).
 * ---------------------------------------------------------------------------
 *   summary(range)  searches, unique vehicles, found / not found, records-API
 *                   speed (average and 95th percentile) and cost, reports
 *                   generated, paid and delivered; by day, state, RTO, type
 *                   and maker.
 *   list(range, …)  the lookups themselves, newest first, searchable:
 *                   who, which vehicle, what it is, found or not, and whether
 *                   it became a report and a payment.
 *
 * A lookup is a vehicle_search_success / vehicle_search_failed event — the
 * moment a customer asked about a vehicle and got an answer (or none).
 * The state and RTO come from the registration number itself (KA 01 …), which
 * is reliable and says nothing about where the person is.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const command = require('./command');

const LOOKUP = `e.name IN ('vehicle_search_success', 'vehicle_search_failed')`;
// "KA01AB1234" -> state KA, RTO KA01. Old-style and BH-series numbers are
// left to their first two letters.
const STATE = `upper(substring(e.reg_no from 1 for 2))`;
const RTO = `CASE WHEN e.reg_no ~ '^[A-Z]{2}[0-9]{2}' THEN upper(substring(e.reg_no from 1 for 4)) ELSE upper(substring(e.reg_no from 1 for 2)) END`;

async function summary(q = {}) {
  const r = command.resolve(q);
  const [n, api, byDay, byState, byRto, byClass, byMaker] = await Promise.all([
    db.one(
      `SELECT count(*) FILTER (WHERE ${LOOKUP})::int AS searches,
              count(DISTINCT e.reg_no) FILTER (WHERE ${LOOKUP})::int AS vehicles,
              count(*) FILTER (WHERE e.name = 'vehicle_search_success')::int AS found,
              count(*) FILTER (WHERE e.name = 'vehicle_search_failed')::int AS failed,
              count(*) FILTER (WHERE e.name = 'report_generated')::int AS reports,
              count(*) FILTER (WHERE e.name = 'payment_success')::int AS paid,
              count(*) FILTER (WHERE e.name = 'report_delivered')::int AS delivered
         FROM events e WHERE e.occurred_at >= $1 AND e.occurred_at < $2`, [r.from, r.to]),
    db.one(
      `SELECT count(*)::int AS calls,
              count(*) FILTER (WHERE NOT cache_hit)::int AS live_calls,
              count(*) FILTER (WHERE cache_hit)::int AS cached,
              count(*) FILTER (WHERE NOT ok)::int AS failed,
              round(avg(duration_ms) FILTER (WHERE NOT cache_hit))::int AS avg_ms,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE NOT cache_hit))::int AS p95_ms,
              coalesce(sum(cost_paise), 0)::int AS cost_paise
         FROM api_calls WHERE created_at >= $1 AND created_at < $2`, [r.from, r.to]),
    db.query(
      `SELECT to_char(e.occurred_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
              count(*) FILTER (WHERE e.name = 'vehicle_search_success')::int AS found,
              count(*) FILTER (WHERE e.name = 'vehicle_search_failed')::int AS failed
         FROM events e WHERE ${LOOKUP} AND e.occurred_at >= $1 AND e.occurred_at < $2
        GROUP BY 1 ORDER BY 1`, [r.from, r.to]),
    db.query(`SELECT ${STATE} AS name, count(*)::int AS count FROM events e
               WHERE ${LOOKUP} AND e.reg_no IS NOT NULL AND e.occurred_at >= $1 AND e.occurred_at < $2
               GROUP BY 1 ORDER BY 2 DESC LIMIT 40`, [r.from, r.to]),
    db.query(`SELECT ${RTO} AS name, count(*)::int AS count FROM events e
               WHERE ${LOOKUP} AND e.reg_no IS NOT NULL AND e.occurred_at >= $1 AND e.occurred_at < $2
               GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [r.from, r.to]),
    db.query(`SELECT coalesce(v.vehicle_class, 'Unknown') AS name, count(*)::int AS count
                FROM events e LEFT JOIN vehicles v ON v.reg_no = e.reg_no
               WHERE e.name = 'vehicle_search_success' AND e.occurred_at >= $1 AND e.occurred_at < $2
               GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, [r.from, r.to]),
    db.query(`SELECT coalesce(initcap(split_part(v.maker, ' ', 1)), 'Unknown') AS name, count(*)::int AS count
                FROM events e LEFT JOIN vehicles v ON v.reg_no = e.reg_no
               WHERE e.name = 'vehicle_search_success' AND e.occurred_at >= $1 AND e.occurred_at < $2
               GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, [r.from, r.to]),
  ]);
  return {
    range: { label: r.label, from: r.from, to: r.to },
    totals: {
      ...n,
      success_pct: n.searches ? Math.round((n.found / n.searches) * 1000) / 10 : null,
      api,
    },
    by_day: byDay.rows, by_state: byState.rows, by_rto: byRto.rows, by_class: byClass.rows, by_maker: byMaker.rows,
  };
}

const RESULTS = { found: `e.name = 'vehicle_search_success'`, failed: `e.name = 'vehicle_search_failed'` };

async function list(q = {}) {
  const r = command.resolve(q);
  const term = String(q.q || '').trim();
  const plate = term.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const digits = term.replace(/\D/g, '');
  const { rows } = await db.query(
    `SELECT e.id, e.occurred_at, e.name, e.channel, e.reg_no, e.error_code,
            coalesce(e.mobile, u.mobile) AS mobile, coalesce(u.display_name, u.wa_profile_name) AS person_name,
            v.maker, v.model, v.fuel, v.vehicle_class, ${STATE} AS state, ${RTO} AS rto,
            EXISTS (SELECT 1 FROM vehicle_reports vr WHERE vr.reg_no = e.reg_no AND vr.user_id = u.id) AS has_report,
            (SELECT p.status FROM payments p WHERE p.user_id = u.id AND p.raw->>'reg_no' = e.reg_no
              ORDER BY p.id DESC LIMIT 1) AS payment_status,
            (SELECT p.amount_paise FROM payments p WHERE p.user_id = u.id AND p.raw->>'reg_no' = e.reg_no
               AND p.status = 'paid' ORDER BY p.id DESC LIMIT 1) AS paid_paise,
            count(*) OVER () AS total
       FROM events e
       LEFT JOIN users u ON u.id = e.user_id OR (e.user_id IS NULL AND u.mobile = e.mobile)
       LEFT JOIN vehicles v ON v.reg_no = e.reg_no
      WHERE ${LOOKUP} AND e.occurred_at >= $1 AND e.occurred_at < $2
        AND (${RESULTS[q.result] || 'true'})
        AND ($3 = '' OR e.reg_no LIKE '%' || $4 || '%' OR coalesce(e.mobile, u.mobile) LIKE '%' || $5 || '%'
             OR v.maker ILIKE '%' || $3 || '%' OR v.model ILIKE '%' || $3 || '%')
      ORDER BY e.occurred_at DESC
      LIMIT $6 OFFSET $7`,
    [r.from, r.to, term, plate || '~', digits || '~', Math.min(200, Number(q.limit) || 50), Number(q.offset) || 0]);
  return {
    total: rows[0] ? Number(rows[0].total) : 0,
    rows: rows.map(({ total, ...x }) => ({ ...x, id: String(x.id) })),
  };
}

module.exports = { summary, list };
