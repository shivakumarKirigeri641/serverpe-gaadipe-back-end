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
 *   node scripts/agreed-numbers.js --csv x.csv  mobile,name for a bulk SMS with a {#var#} name
 *                                               (2026-10-20: "Dear {#var#}" in gp_service_moved_v1;
 *                                               first name, or "Customer" when none is known)
 *
 *   node scripts/agreed-numbers.js --all --batch 1 --csv b1.csv
 *                                               IN BATCHES (2026-10-20: "if I SMS all 312, all will
 *                                               message at once" — the new number's first days):
 *                                               --batch N picks the Nth group of --size (50), paying
 *                                               customers first, then the most recently active; anyone
 *                                               who already wrote to the new number
 *                                               (whatsapp_number_since) is left out, so a later batch
 *                                               never asks someone twice
 *
 * Prints the count, then the 10-digit numbers, one per line.
 */
require('dotenv').config();
const fs = require('fs');
const db = require('../src/db');

const args = process.argv.slice(2);
const all = args.includes('--all');
const file = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const csv = args.includes('--csv') ? args[args.indexOf('--csv') + 1] : null;
const batch = args.includes('--batch') ? Math.max(1, Number(args[args.indexOf('--batch') + 1]) || 1) : null;
const size = args.includes('--size') ? Math.max(1, Number(args[args.indexOf('--size') + 1]) || 50) : 50;
// A first name fit for "Dear {#var#}": letters only, at most 20, else "Customer".
const firstName = (s) => {
  const w = String(s || '').trim().split(/\s+/)[0].replace(/[^A-Za-zऀ-ॿ.]/g, '');
  return w.length >= 2 ? w.slice(0, 20).replace(/^./, (c) => c.toUpperCase()) : 'Customer';
};

(async () => {
  const since = (await db.one(`SELECT value FROM app_settings WHERE key = 'whatsapp_number_since'`))?.value || null;
  const { rows: everyone } = await db.query(
    `WITH agreed AS (
       SELECT DISTINCT right(regexp_replace(c.detail->>'mobile', '\\D', '', 'g'), 10) AS m
         FROM event_log c
        WHERE c.kind = 'consent_accepted'
          ${all ? '' : `AND coalesce(c.detail->>'channel', 'whatsapp') = 'whatsapp'`})
     SELECT a.m,
            (SELECT coalesce(u.display_name, u.wa_profile_name) FROM users u
              WHERE right(u.mobile, 10) = a.m ORDER BY u.id LIMIT 1) AS name,
            EXISTS (SELECT 1 FROM payments p JOIN users u ON u.id = p.user_id
                     WHERE right(u.mobile, 10) = a.m AND p.status = 'paid' AND p.amount_paise > 0) AS paid,
            (SELECT max(w.created_at) FROM whatsapp_messages w
              WHERE w.direction = 'in' AND right(regexp_replace(w.mobile, '\\D', '', 'g'), 10) = a.m) AS last_in,
            ${since ? `EXISTS (SELECT 1 FROM whatsapp_messages w WHERE w.direction = 'in'
                     AND right(regexp_replace(w.mobile, '\\D', '', 'g'), 10) = a.m AND w.created_at >= $1)` : 'false'} AS on_new
       FROM agreed a
      WHERE length(a.m) = 10
        AND NOT EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE right(s.mobile, 10) = a.m AND s.wa_opt_out_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM users u WHERE right(u.mobile, 10) = a.m AND (u.is_internal OR u.deactivated_at IS NOT NULL))
      ORDER BY a.m`, since ? [since] : []);
  // Batches: paying customers first, then the most recently active; never someone already on the new number.
  let rows = everyone;
  if (batch) {
    // A FIXED order over everyone, so batch 2 tomorrow never repeats batch 1's people (only the
    // ones already on the new number drop out of their own slice). Paying first, then the most
    // recently active, ties by number.
    const ordered = [...everyone]
      .sort((x, y) => (Number(y.paid) - Number(x.paid)) || (new Date(y.last_in || 0) - new Date(x.last_in || 0)) || x.m.localeCompare(y.m));
    const slice = ordered.slice((batch - 1) * size, batch * size);
    rows = slice.filter((r) => !r.on_new);
    console.log(`Batch ${batch} of ${Math.ceil(ordered.length / size)} (${size} each): ${rows.length} numbers to SMS, `
      + `${rows.filter((r) => r.paid).length} paying; ${slice.length - rows.length} of this batch already said Hi to the new number.`);
  }
  const list = rows.map((r) => r.m);
  console.log(`${list.length} numbers (${all ? 'WhatsApp + website' : 'WhatsApp'} agreements; STOP, internal and closed accounts left out)\n`);
  // One per line (user: "no, line by line"); --comma for a single comma-separated line.
  console.log(list.join(args.includes('--comma') ? ',' : '\n'));
  if (file) { fs.writeFileSync(file, `${list.join('\n')}\n`); console.log(`\nAlso written to ${file}, one per line.`); }
  if (csv) {
    fs.writeFileSync(csv, `mobile,name\n${rows.map((r) => `${r.m},${firstName(r.name)}`).join('\n')}\n`);
    console.log(`\nAlso written to ${csv} as mobile,name (${rows.filter((r) => firstName(r.name) !== 'Customer').length} with a name).`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
