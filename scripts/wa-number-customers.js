/**
 * scripts/wa-number-customers.js — WHO CAME IN THROUGH A WHATSAPP NUMBER (user, 2026-10-23: "mark the new users
 * arriving on this number, so I can SMS them if WhatsApp is disabled, to continue on the web"). Read-only.
 * From user_wa_numbers (migration 210): every customer who wrote to that business number, with when.
 * Left out: our own (internal) numbers, closed accounts, blocked numbers. A STOP on WhatsApp is about WhatsApp,
 * so they are kept — the SMS is a service notice about their account, and DLT rules still apply.
 *
 *   node scripts/wa-number-customers.js                    the current number (.env), count and numbers
 *   node scripts/wa-number-customers.js 917996083415       a given number
 *   node scripts/wa-number-customers.js --csv wa.csv       also mobile,name for a bulk SMS ({#var#} = name)
 *   node scripts/wa-number-customers.js --paid             only those who paid at least once
 */
require('dotenv').config();
const fs = require('fs');
const db = require('../src/db');
const { config } = require('../src/config');

const args = process.argv.slice(2);
const csv = args.includes('--csv') ? args[args.indexOf('--csv') + 1] : null;
const paidOnly = args.includes('--paid');
const given = args.find((a) => /^\d{10,13}$/.test(a));
const number = String(given || config.whatsapp.ownNumber || '').replace(/\D/g, '');
const firstName = (s) => {
  const w = String(s || '').trim().split(/\s+/)[0].replace(/[^A-Za-zऀ-ॿ.]/g, '');
  return w.length >= 2 ? w.slice(0, 20).replace(/^./, (c) => c.toUpperCase()) : 'Customer';
};

(async () => {
  if (!number) { console.log('No WhatsApp number given and none in .env (WHATSAPP_BUSINESS_PHONENUMBER).'); process.exit(1); }
  const { rows } = await db.query(
    `SELECT right(regexp_replace(u.mobile, '\\D', '', 'g'), 10) AS m, coalesce(u.display_name, u.wa_profile_name, u.name) AS name,
            x.first_at, EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0) AS paid
       FROM user_wa_numbers x JOIN users u ON u.id = x.user_id
      WHERE x.business_number = $1
        AND NOT coalesce(u.is_internal, false) AND u.deactivated_at IS NULL AND u.mobile IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.kind = 'mobile' AND b.released_at IS NULL AND right(b.value, 10) = right(regexp_replace(u.mobile, '\\D', '', 'g'), 10))
      ORDER BY x.first_at`, [number]).catch(async (e) => {
    // The blocks table may be named differently on an older database: list without that filter.
    if (!/blocks/.test(e.message)) throw e;
    return db.query(
      `SELECT right(regexp_replace(u.mobile, '\\D', '', 'g'), 10) AS m, coalesce(u.display_name, u.wa_profile_name, u.name) AS name, x.first_at,
              EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0) AS paid
         FROM user_wa_numbers x JOIN users u ON u.id = x.user_id
        WHERE x.business_number = $1 AND NOT coalesce(u.is_internal, false) AND u.deactivated_at IS NULL AND u.mobile IS NOT NULL
        ORDER BY x.first_at`, [number]);
  });
  const list = rows.filter((r) => /^[6-9]\d{9}$/.test(r.m) && (!paidOnly || r.paid));
  console.log(`\n${list.length} customer(s) who came in through WhatsApp +${number}${paidOnly ? ' and paid' : ''} (our own numbers, closed and blocked left out)\n`);
  for (const r of list) console.log(`${r.m}  ${new Date(r.first_at).toISOString().slice(0, 10)}  ${r.paid ? 'paid' : ''}`);
  if (csv) {
    fs.writeFileSync(csv, `mobile,name\n${list.map((r) => `${r.m},${firstName(r.name)}`).join('\n')}\n`);
    console.log(`\nWritten to ${csv} as mobile,name — delete it after sending (it holds customers' numbers).`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
