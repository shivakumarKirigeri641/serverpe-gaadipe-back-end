/**
 * scripts/comeback.js — WHO CAME BACK, AND WHAT THEY DID AFTER SEEING THE PRICES (user, 2026-10-26: "200+ SMS went;
 * I don't know how many will come and go back after seeing the pricing"). Read-only; sends nothing.
 *
 *   node scripts/comeback.js            since midnight today (IST)
 *   node scripts/comeback.js 6          the last 6 hours
 *
 * "Came back" = an existing customer (joined before today) who wrote on WhatsApp in the window. For them:
 * checked a vehicle, used the free check, saw the packs (checks_out), and bought a pack or a report.
 */
require('dotenv').config();
const db = require('../src/db');

const hours = parseInt(process.argv[2], 10);
const SINCE = Number.isFinite(hours) && hours > 0
  ? `now() - interval '${Math.min(hours, 72)} hours'`
  : `date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`;

(async () => {
  const { rows } = await db.query(
    `WITH back AS (
       SELECT DISTINCT u.id, u.mobile
         FROM whatsapp_messages w JOIN users u ON right(u.mobile, 10) = right(w.mobile, 10)
        WHERE w.direction = 'in' AND w.created_at >= ${SINCE}
          AND u.created_at < ${SINCE} AND NOT coalesce(u.is_internal, false)
     )
     SELECT
       (SELECT count(*) FROM back)::int AS came_back,
       (SELECT count(DISTINCT e.user_id) FROM event_log e JOIN back b ON b.id = e.user_id
         WHERE e.kind IN ('vehicle_check', 'vehicle_check_repeat') AND e.created_at >= ${SINCE})::int AS checked,
       (SELECT count(DISTINCT e.user_id) FROM event_log e JOIN back b ON b.id = e.user_id
         WHERE e.kind = 'checks_out' AND e.created_at >= ${SINCE})::int AS saw_packs,
       (SELECT count(DISTINCT p.user_id) FROM payments p JOIN back b ON b.id = p.user_id JOIN plans pl ON pl.id = p.plan_id
         WHERE p.status = 'paid' AND p.amount_paise > 0 AND pl.kind = 'checks' AND p.paid_at >= ${SINCE})::int AS bought_pack,
       (SELECT count(DISTINCT p.user_id) FROM payments p JOIN back b ON b.id = p.user_id JOIN plans pl ON pl.id = p.plan_id
         WHERE p.status = 'paid' AND p.amount_paise > 0 AND pl.kind = 'report' AND p.paid_at >= ${SINCE})::int AS bought_report,
       (SELECT coalesce(sum(p.amount_paise), 0) FROM payments p JOIN back b ON b.id = p.user_id
         WHERE p.status = 'paid' AND p.amount_paise > 0 AND p.paid_at >= ${SINCE})::int AS paise,
       (SELECT count(*) FROM whatsapp_sessions s JOIN back b ON right(b.mobile, 10) = right(s.mobile, 10)
         WHERE s.wa_opt_out_at >= ${SINCE})::int AS stopped`);
  const r = rows[0];
  const pct = (n) => (r.came_back ? ` (${Math.round((100 * n) / r.came_back)}%)` : '');
  console.log(`\nExisting customers who came back on WhatsApp ${Number.isFinite(hours) && hours > 0 ? `in the last ${hours} h` : 'today'}`);
  console.log(`  came back (wrote to GaadiPe)      ${r.came_back}`);
  console.log(`  checked a vehicle                 ${r.checked}${pct(r.checked)}`);
  console.log(`  were shown the packs (no checks)  ${r.saw_packs}${pct(r.saw_packs)}`);
  console.log(`  bought a check pack               ${r.bought_pack}${pct(r.bought_pack)}`);
  console.log(`  bought a full report              ${r.bought_report}${pct(r.bought_report)}`);
  console.log(`  replied STOP                      ${r.stopped}${pct(r.stopped)}`);
  console.log(`  money from them                   ₹${Math.round(r.paise / 100)}\n`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
