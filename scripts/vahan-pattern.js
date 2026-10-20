/**
 * scripts/vahan-pattern.js — WHY HAS ULIP'S VAHAN NOT ANSWERED FOR A MONTH? (user, 2026-10-20: "its been
 * 1 month, they are not up"). FASTag and e-Challan work on the same ULIP account, VAHAN/01 and /04
 * answer EMPTY_RECORD / NO_DATA_FOUND. Read-only — no call to ULIP or anyone:
 *
 *   1. day by day, last 45 days: VAHAN FOUND vs empty — when it changed
 *   2. by vehicle class (commercial/transport vs private), last 30 days — does ULIP still answer
 *      for some kinds of vehicle? (ULIP is a logistics platform)
 *   3. ULIP's exact error messages, and the vehicles it still answered
 *
 *   node scripts/vahan-pattern.js
 */
require('dotenv').config();
const db = require('../src/db');

const day = (d) => new Date(d).toISOString().slice(0, 10);

(async () => {
  const daily = await db.query(
    `SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d,
            count(*) FILTER (WHERE outcome = 'FOUND')::int AS found,
            count(*) FILTER (WHERE outcome = 'NOT_FOUND')::int AS not_found,
            count(*) FILTER (WHERE outcome IN ('RETRY', 'REJECTED'))::int AS failed
       FROM api_calls
      WHERE provider_path LIKE 'VAHAN/%' AND NOT cache_hit AND created_at > now() - interval '45 days'
      GROUP BY 1 ORDER BY 1`);
  console.log('\n1. ULIP VAHAN, day by day (FOUND / not found / failed-empty):');
  for (const r of daily.rows) console.log(`   ${r.d}   found ${String(r.found).padStart(3)}   not-found ${String(r.not_found).padStart(3)}   failed ${String(r.failed).padStart(3)}`);
  const lastFound = await db.one(`SELECT max(created_at) AS at FROM api_calls WHERE provider_path LIKE 'VAHAN/%' AND outcome = 'FOUND'`);
  console.log(`   last FOUND ever: ${lastFound?.at ? new Date(lastFound.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'never'}`);

  const byClass = await db.query(
    `WITH v AS (
       SELECT a.reg_no, bool_or(a.outcome = 'FOUND') AS found,
              max(coalesce(ve.vehicle_class, '')) AS cls
         FROM api_calls a LEFT JOIN vehicles ve ON ve.id = a.vehicle_id OR ve.reg_no = a.reg_no
        WHERE a.provider_path LIKE 'VAHAN/%' AND NOT a.cache_hit AND a.created_at > now() - interval '30 days'
        GROUP BY a.reg_no)
     SELECT CASE WHEN cls ~* '(goods|transport|taxi|cab|bus|truck|lorry|tractor|trailer|commercial|contract|stage|maxi|lgv|hgv|mgv|e-rickshaw|three wheeler \\(t\\))' THEN 'commercial / transport'
                 WHEN cls = '' THEN 'class unknown'
                 ELSE 'private / non-transport' END AS kind,
            count(*)::int AS vehicles, count(*) FILTER (WHERE found)::int AS ulip_answered
       FROM v GROUP BY 1 ORDER BY 2 DESC`).catch((e) => ({ rows: [], error: e.message }));
  console.log('\n2. Last 30 days, by kind of vehicle (did ULIP VAHAN answer at least once?):');
  if (byClass.error) console.log('   (could not group by class:', byClass.error, ')');
  for (const r of byClass.rows) console.log(`   ${r.kind.padEnd(26)} ${String(r.vehicles).padStart(4)} vehicles · ULIP answered ${r.ulip_answered}`);

  const msgs = await db.query(
    `SELECT provider_path, error_code, left(coalesce(error_message, ''), 140) AS msg, count(*)::int AS n, max(created_at) AS last
       FROM api_calls
      WHERE provider_path LIKE 'VAHAN/%' AND outcome <> 'FOUND' AND created_at > now() - interval '30 days'
      GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 8`);
  console.log('\n3a. ULIP VAHAN error messages, last 30 days:');
  for (const r of msgs.rows) console.log(`   ${r.provider_path} ${String(r.error_code || '').padEnd(14)} ×${String(r.n).padStart(4)}  "${r.msg}"  (last ${day(r.last)})`);

  const answered = await db.query(
    `SELECT a.reg_no, a.provider_path, a.created_at, coalesce(ve.vehicle_class, '') AS cls, coalesce(ve.maker, '') AS maker
       FROM api_calls a LEFT JOIN vehicles ve ON ve.reg_no = a.reg_no
      WHERE a.provider_path LIKE 'VAHAN/%' AND a.outcome = 'FOUND' AND a.created_at > now() - interval '30 days'
      ORDER BY a.created_at DESC LIMIT 12`);
  console.log('\n3b. Vehicles ULIP VAHAN still answered, last 30 days:');
  if (!answered.rows.length) console.log('   none');
  for (const r of answered.rows) console.log(`   ${day(r.created_at)}  ${r.reg_no}  ${r.provider_path}  ${r.cls}  ${r.maker}`);
  console.log('\nRead-only — nothing was called.\n');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
