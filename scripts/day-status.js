/**
 * scripts/day-status.js — ONE LOOK AT HOW THE DAY WENT (user, 2026-10-25: "shall we check status?"). Read-only.
 *
 *   node scripts/day-status.js            the last 24 hours
 *   node scripts/day-status.js 48         the last 48 hours
 *
 * New people (came, which WhatsApp number, agreed, checks, paid), payments, paid RC lookups and what they cost,
 * WhatsApp sent and failed, and accounts deactivated. Numbers shown as the last 4 digits only.
 */
require('dotenv').config();
const db = require('../src/db');

const hours = Math.min(Math.max(parseInt(process.argv[2], 10) || 24, 1), 24 * 14);
const since = `now() - interval '${hours} hours'`;
const AGREED = (col) => `EXISTS (SELECT 1 FROM event_log e WHERE e.kind = 'consent_accepted'
  AND right(regexp_replace(e.detail->>'mobile', '\\D', '', 'g'), 10) = right(regexp_replace(${col}, '\\D', '', 'g'), 10))`;

(async () => {
  const q = async (sql) => (await db.query(sql).catch((e) => ({ rows: [{ error: e.message }] }))).rows;

  console.log(`\n── New people, last ${hours} h`);
  const people = await q(`
    SELECT right(coalesce(u.archived_mobile, u.mobile), 4) AS last4,
           to_char(u.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') AS came,
           coalesce(u.wa_business_number, '') AS via,
           ${AGREED('coalesce(u.archived_mobile, u.mobile)')} AS agreed,
           (SELECT count(*)::int FROM event_log e WHERE e.user_id = u.id AND e.kind = 'vehicle_check') AS checks,
           EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0) AS paid,
           u.deactivated_at IS NOT NULL AS left
      FROM users u
     WHERE u.created_at > ${since} AND NOT coalesce(u.is_internal, false)
     ORDER BY u.created_at`);
  if (people.length) console.table(people); else console.log('   nobody new');
  const n = people.length;
  console.log(`   ${n} new · ${people.filter((p) => p.agreed).length} agreed · `
    + `${people.filter((p) => p.checks > 0).length} checked · ${people.filter((p) => p.paid).length} paid`);

  console.log(`\n── Payments, last ${hours} h`);
  const pays = await q(`
    SELECT to_char(coalesce(p.paid_at, p.created_at) AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') AS at,
           right(coalesce(u.archived_mobile, u.mobile), 4) AS last4, coalesce(p.raw->>'reg_no', '') AS vehicle,
           '₹' || round(p.amount_paise / 100.0) AS amount, coalesce(p.raw->>'channel', 'whatsapp') AS channel
      FROM payments p LEFT JOIN users u ON u.id = p.user_id
     WHERE p.status = 'paid' AND p.amount_paise > 0 AND coalesce(p.paid_at, p.created_at) > ${since}
     ORDER BY 1`);
  if (pays.length) console.table(pays); else console.log('   no payments');

  console.log(`\n── Vehicle checks (people) and paid RC lookups, last ${hours} h`);
  console.table(await q(`
    SELECT (SELECT count(*)::int FROM event_log WHERE kind = 'vehicle_check' AND created_at > ${since}) AS checks,
           count(*) FILTER (WHERE provider_path IN ('WAY2API', 'RCBACKUP'))::int AS paid_lookups,
           '₹' || coalesce(round(sum(cost_paise) / 100.0, 2), 0) AS lookup_cost
      FROM api_calls WHERE created_at > ${since} AND NOT cache_hit`));

  console.log(`\n── WhatsApp out, last ${hours} h`);
  const wa = await q(`
    SELECT CASE WHEN m.template_name IS NOT NULL THEN 'template ' || m.template_name ELSE 'chat (' || m.message_type || ')' END AS kind,
           count(*)::int AS sent,
           count(*) FILTER (WHERE m.error_message IS NOT NULL
                              OR EXISTS (SELECT 1 FROM whatsapp_status_logs s WHERE s.wa_message_id = m.wa_message_id AND s.status = 'failed'))::int AS failed,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM whatsapp_status_logs s WHERE s.wa_message_id = m.wa_message_id AND s.status = 'read'))::int AS read
      FROM whatsapp_messages m
     WHERE m.direction = 'out' AND m.created_at > ${since}
     GROUP BY 1 ORDER BY 2 DESC`);
  if (wa.length) console.table(wa); else console.log('   none');

  const left = await q(`SELECT count(*)::int AS n FROM users WHERE deactivated_at > ${since}`);
  console.log(`\n── Accounts deactivated: ${left[0]?.n ?? 0}`);
  console.log('\nFor WhatsApp quality and account health: node scripts/wa-check.js');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
