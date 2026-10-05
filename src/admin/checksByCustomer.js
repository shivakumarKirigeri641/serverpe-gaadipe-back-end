/**
 * src/admin/checksByCustomer.js — how many vehicles each customer checked,
 * and how many times, day by day (user, 2026-10-05).
 *
 * From event_log: every check is 'vehicle_check' (a new vehicle that day's
 * quota counts) or 'vehicle_check_repeat' (the same vehicle again inside the
 * repeat window), with the vehicle in detail.reg_no and whether the
 * Government record was found — WhatsApp and the website alike
 * (util/quota.js record). One row per customer per IST day.
 */

const db = require('../db');

const mask = (m) => (m ? `••••••${String(m).slice(-4)}` : null);

/**
 * days   how many IST days back, today included (1 = today)
 * day    one IST date (YYYY-MM-DD) instead of `days`
 * min    only customers with at least this many checks that day
 */
async function list({ days = 1, day = null, min = 1, limit = 500 } = {}) {
  const d = Math.min(90, Math.max(1, Number(days) || 1));
  const one = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? day : null;
  const { rows } = await db.query(
    `WITH c AS (
       SELECT e.user_id, e.kind, e.detail->>'reg_no' AS reg_no,
              coalesce((e.detail->>'found')::boolean, true) AS found, e.created_at,
              (e.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day
         FROM event_log e
        WHERE e.kind IN ('vehicle_check', 'vehicle_check_repeat') AND e.user_id IS NOT NULL
          AND ($1::date IS NOT NULL AND (e.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
               OR $1::date IS NULL AND (e.created_at AT TIME ZONE 'Asia/Kolkata')::date
                    > (now() AT TIME ZONE 'Asia/Kolkata')::date - $2::int)
     ),
     per_vehicle AS (
       SELECT user_id, day, reg_no, count(*)::int AS n, bool_or(found) AS found, max(created_at) AS last
         FROM c GROUP BY user_id, day, reg_no
     ),
     per_day AS (
       SELECT user_id, day, count(*)::int AS checks, count(DISTINCT reg_no)::int AS vehicles,
              count(*) FILTER (WHERE NOT found)::int AS not_found,
              min(created_at) AS first_at, max(created_at) AS last_at
         FROM c GROUP BY user_id, day
     )
     SELECT p.*, to_char(p.day, 'YYYY-MM-DD') AS day_s, u.mobile, coalesce(u.wa_profile_name, u.display_name) AS name,
            (SELECT jsonb_agg(jsonb_build_object('reg_no', v.reg_no, 'n', v.n, 'found', v.found) ORDER BY v.n DESC, v.last DESC)
               FROM per_vehicle v WHERE v.user_id = p.user_id AND v.day = p.day) AS list,
            (SELECT count(*)::int FROM payments x WHERE x.user_id = p.user_id AND x.status = 'paid' AND x.amount_paise > 0) AS paid
       FROM per_day p JOIN users u ON u.id = p.user_id
      WHERE p.checks >= $3
      ORDER BY p.day DESC, p.checks DESC, p.last_at DESC
      LIMIT $4`, [one, d, Math.max(1, Number(min) || 1), Math.min(2000, Number(limit) || 500)]);

  const out = rows.map((r) => ({
    day: r.day_s,
    user_id: String(r.user_id), name: r.name, masked: mask(r.mobile), mobile: r.mobile,
    checks: r.checks, vehicles: r.vehicles, repeats: r.checks - r.vehicles, not_found: r.not_found,
    first_at: r.first_at, last_at: r.last_at, paid: r.paid, list: r.list || [],
  }));
  const totals = {
    customers: new Set(out.map((r) => r.user_id)).size,
    checks: out.reduce((a, r) => a + r.checks, 0),
    vehicles: out.reduce((a, r) => a + r.vehicles, 0),
    heavy: out.filter((r) => r.checks >= 10).length,
  };
  return { days: one ? 1 : d, day: one, totals, rows: out };
}

module.exports = { list };
