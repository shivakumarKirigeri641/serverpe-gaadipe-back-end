/**
 * scripts/agreed-numbers.js — THE MOBILE NUMBERS OF EVERYONE WHO AGREED (user, 2026-10-15:
 * "script to get the 172 numbers", for an SMS from Fast2SMS). The same people the admin
 * counts (admin/consented.js): agreed to the Terms, never replied STOP, not an internal
 * (owner's) number, not deactivated.
 *
 *   node scripts/agreed-numbers.js              WhatsApp agreements (what the main admin counts)
 *   node scripts/agreed-numbers.js --all        WhatsApp and website agreements
 *   node scripts/agreed-numbers.js --file x.txt also write one number per line to x.txt
 *   node scripts/agreed-numbers.js --comma      one comma-separated line instead
 *
 * Prints the count, then the 10-digit numbers, one per line.
 */
require('dotenv').config();
const fs = require('fs');
const db = require('../src/db');

const args = process.argv.slice(2);
const all = args.includes('--all');
const file = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;

(async () => {
  const { rows } = await db.query(
    `WITH agreed AS (
       SELECT DISTINCT right(regexp_replace(c.detail->>'mobile', '\\D', '', 'g'), 10) AS m
         FROM event_log c
        WHERE c.kind = 'consent_accepted'
          ${all ? '' : `AND coalesce(c.detail->>'channel', 'whatsapp') = 'whatsapp'`})
     SELECT a.m FROM agreed a
      WHERE length(a.m) = 10
        AND NOT EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE right(s.mobile, 10) = a.m AND s.wa_opt_out_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM users u WHERE right(u.mobile, 10) = a.m AND (u.is_internal OR u.deactivated_at IS NOT NULL))
      ORDER BY a.m`);
  const list = rows.map((r) => r.m);
  console.log(`${list.length} numbers (${all ? 'WhatsApp + website' : 'WhatsApp'} agreements; STOP, internal and closed accounts left out)\n`);
  // One per line (user: "no, line by line"); --comma for a single comma-separated line.
  console.log(list.join(args.includes('--comma') ? ',' : '\n'));
  if (file) { fs.writeFileSync(file, `${list.join('\n')}\n`); console.log(`\nAlso written to ${file}, one per line.`); }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
