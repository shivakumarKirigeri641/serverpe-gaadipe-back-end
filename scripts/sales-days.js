/**
 * scripts/sales-days.js — DAY BY DAY, BEFORE AND AFTER THE CHECK PACKS (user, 2026-10-27: "after putting those price
 * plans, paying customers reduced drastically"). Read-only; sends nothing.
 *
 *   node scripts/sales-days.js        the last 10 days (IST)
 *   node scripts/sales-days.js 14     the last 14 days
 *
 * Per day: new people, agreed, checks (found / not found), orders opened, reports and packs paid, money in, and the
 * paid RC lookups. "Not found" matters: a check that finds nothing can never sell a report.
 */
require('dotenv').config();
const db = require('../src/db');

const days = Math.max(2, Math.min(60, parseInt(process.argv[2], 10) || 10));
const DAY = (col) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`;

(async () => {
  const { rows } = await db.query(
    `WITH d AS (
       SELECT generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - ${days - 1},
                              (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day')::date AS day)
     SELECT to_char(d.day, 'DD Mon Dy') AS day,
       (SELECT count(*) FROM users u WHERE ${DAY('u.created_at')} = d.day AND NOT coalesce(u.is_internal, false))::int AS new,
       (SELECT count(*) FROM users u WHERE ${DAY('u.created_at')} = d.day AND NOT coalesce(u.is_internal, false)
           AND EXISTS (SELECT 1 FROM event_log c WHERE c.kind = 'consent_accepted'
                 AND right(regexp_replace(c.detail->>'mobile', '\\D', '', 'g'), 10)
                   = right(regexp_replace(coalesce(u.archived_mobile, u.mobile), '\\D', '', 'g'), 10)))::int AS agreed,
       (SELECT count(*) FROM event_log e WHERE e.kind = 'vehicle_check' AND ${DAY('e.created_at')} = d.day
           AND coalesce(e.detail->>'found', 'true') <> 'false')::int AS found,
       (SELECT count(*) FROM event_log e WHERE e.kind = 'vehicle_check' AND ${DAY('e.created_at')} = d.day
           AND e.detail->>'found' = 'false')::int AS not_found,
       (SELECT count(*) FROM event_log e WHERE e.kind = 'checks_out' AND ${DAY('e.created_at')} = d.day)::int AS saw_packs,
       (SELECT count(DISTINCT p.user_id) FROM payments p WHERE ${DAY('p.created_at')} = d.day)::int AS opened_pay,
       (SELECT count(*) FROM payments p JOIN plans pl ON pl.id = p.plan_id
         WHERE p.status = 'paid' AND p.amount_paise > 0 AND pl.kind = 'report' AND ${DAY('p.paid_at')} = d.day)::int AS reports,
       (SELECT count(*) FROM payments p JOIN plans pl ON pl.id = p.plan_id
         WHERE p.status = 'paid' AND p.amount_paise > 0 AND pl.kind = 'checks' AND ${DAY('p.paid_at')} = d.day)::int AS packs,
       (SELECT coalesce(sum(p.amount_paise), 0) FROM payments p
         WHERE p.status = 'paid' AND p.amount_paise > 0 AND ${DAY('p.paid_at')} = d.day)::int AS paise,
       (SELECT count(*) FROM api_calls a WHERE ${DAY('a.created_at')} = d.day AND coalesce(a.cost_paise, 0) > 0)::int AS paid_lookups
     FROM d ORDER BY d.day`).catch(async (e) => {
    // Older databases name a column differently - say which, rather than guess.
    throw new Error(`${e.message} (check the column names in scripts/sales-days.js)`);
  });
  console.log(`\nGaadiPe day by day, last ${days} days (IST). Check packs went live on 26 Oct.\n`);
  console.table(rows.map((r) => ({
    day: r.day, new: r.new, agreed: r.agreed, 'checks found': r.found, 'not found': r.not_found,
    'saw packs': r.saw_packs, 'opened pay': r.opened_pay, reports: r.reports, packs: r.packs,
    '₹ in': Math.round(r.paise / 100), 'paid lookups': r.paid_lookups,
  })));
  const sum = (from, to) => rows.slice(from, to).reduce((a, r) => ({
    n: a.n + 1, sales: a.sales + r.reports + r.packs, rs: a.rs + r.paise / 100, found: a.found + r.found, nf: a.nf + r.not_found }),
  { n: 0, sales: 0, rs: 0, found: 0, nf: 0 });
  const cut = rows.findIndex((r) => /^26 Oct/.test(r.day));
  if (cut > 0) {
    const b = sum(0, cut); const a = sum(cut, rows.length);
    const line = (t, s) => console.log(`  ${t}: ${(s.sales / s.n).toFixed(1)} sales/day · ₹${Math.round(s.rs / s.n)}/day · `
      + `checks found ${Math.round((100 * s.found) / Math.max(1, s.found + s.nf))}%`);
    line(`before packs (${b.n} days)`, b);
    line(`after packs  (${a.n} days)`, a);
  }
  console.log('');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
