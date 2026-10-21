/**
 * scripts/agreed-count.js — HOW MANY CUSTOMERS AGREED (user, 2026-10-21: "script for total customers,
 * agreed only"). Read-only. The same rule as the admin (admin/consented.js) and agreed-numbers.js:
 * agreed to the Terms on WhatsApp or the website, never replied STOP, not an internal (owner's) number,
 * not a closed account. One mobile counts once.
 *
 *   node scripts/agreed-count.js
 */
require('dotenv').config();
const db = require('../src/db');

const M = (c) => `right(regexp_replace(${c}, '\\D', '', 'g'), 10)`;

(async () => {
  const { rows: [r] } = await db.query(
    `WITH c AS (
       SELECT ${M(`detail->>'mobile'`)} AS m,
              bool_or(coalesce(detail->>'channel', 'whatsapp') = 'whatsapp') AS wa,
              bool_or(detail->>'channel' = 'web') AS web,
              min(created_at) AS first_at
         FROM event_log WHERE kind = 'consent_accepted' GROUP BY 1),
     ok AS (
       SELECT c.* FROM c
        WHERE length(c.m) = 10
          AND NOT EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE right(s.mobile, 10) = c.m AND s.wa_opt_out_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM users u WHERE right(u.mobile, 10) = c.m AND (u.is_internal OR u.deactivated_at IS NOT NULL)))
     SELECT count(*)::int AS total,
            count(*) FILTER (WHERE wa AND NOT web)::int AS whatsapp_only,
            count(*) FILTER (WHERE web AND NOT wa)::int AS website_only,
            count(*) FILTER (WHERE wa AND web)::int AS both,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM payments p JOIN users u ON u.id = p.user_id
                                            WHERE right(u.mobile, 10) = ok.m AND p.status = 'paid' AND p.amount_paise > 0))::int AS paid,
            count(*) FILTER (WHERE first_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS today,
            count(*) FILTER (WHERE first_at >= now() - interval '7 days')::int AS last_7_days,
            (SELECT count(*)::int FROM c WHERE length(c.m) = 10
               AND EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE right(s.mobile, 10) = c.m AND s.wa_opt_out_at IS NOT NULL)) AS left_out_stop
       FROM ok`);
  console.log('\nGaadiPe customers who agreed (STOP, internal and closed accounts left out)\n');
  console.log(`  Total                        ${r.total}`);
  console.log(`    agreed on WhatsApp only    ${r.whatsapp_only}`);
  console.log(`    agreed on the website only ${r.website_only}`);
  console.log(`    agreed on both             ${r.both}`);
  console.log(`  Paid at least once           ${r.paid}`);
  console.log(`  New today (IST)              ${r.today}`);
  console.log(`  New in the last 7 days       ${r.last_7_days}`);
  console.log(`  Left out: replied STOP       ${r.left_out_stop}\n`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
