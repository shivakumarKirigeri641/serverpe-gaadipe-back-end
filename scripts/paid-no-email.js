/**
 * scripts/paid-no-email.js — PAYING CUSTOMERS WITHOUT A CONFIRMED EMAIL (user, 2026-10-20: "many
 * have not updated their mails, give me a script where customers paid but not updated mail").
 * Email is where the full challan details and alerts go, so these are the people to ask.
 * Read-only: sends nothing.
 *
 *   node scripts/paid-no-email.js                 the list
 *   node scripts/paid-no-email.js --csv x.csv     also mobile,name,email,status,... for an SMS or a call list
 *
 * Status:  NO EMAIL       never gave one
 *          NOT CONFIRMED  gave one, never typed the code / clicked the link
 * "On new no." = wrote to the new WhatsApp number (whatsapp_number_since): their 24-hour chat is
 * open or was recently, so asking them there is free — the bot's "Add email" button does it.
 * Left out: internal (owner's) numbers, closed accounts, test-mode payments.
 */
require('dotenv').config();
const fs = require('fs');
const db = require('../src/db');

const args = process.argv.slice(2);
const csv = args.includes('--csv') ? args[args.indexOf('--csv') + 1] : null;
const ist = (t) => (t ? new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }) : '—');
const tenOf = (m) => String(m || '').replace(/\D/g, '').slice(-10);

(async () => {
  const since = (await db.one(`SELECT value FROM app_settings WHERE key = 'whatsapp_number_since'`))?.value || null;
  const { rows } = await db.query(
    `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.email, u.email_verified_at,
            count(p.id)::int AS paid_count, sum(p.amount_paise)::bigint AS paid_paise, max(p.paid_at) AS last_paid,
            (SELECT v.reg_no FROM payments x JOIN vehicles v ON v.id = (x.raw->>'vehicle_id')::bigint
              WHERE x.user_id = u.id AND x.status = 'paid' ORDER BY x.paid_at DESC LIMIT 1) AS last_vehicle,
            ${since ? `EXISTS (SELECT 1 FROM whatsapp_messages w WHERE w.direction = 'in'
                      AND right(regexp_replace(w.mobile, '\\D', '', 'g'), 10) = right(u.mobile, 10) AND w.created_at >= $1)` : 'false'} AS on_new
       FROM users u
       JOIN payments p ON p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0
                      AND coalesce((p.raw->>'test_mode')::text, '') = ''
      WHERE u.email_verified_at IS NULL
        AND NOT coalesce(u.is_internal, false) AND u.deactivated_at IS NULL
      GROUP BY u.id
      ORDER BY (u.email IS NULL), max(p.paid_at) DESC`, since ? [since] : []);

  const none = rows.filter((r) => !r.email);
  const unconfirmed = rows.filter((r) => r.email);
  const total = (await db.one(
    `SELECT count(DISTINCT u.id)::int AS n FROM users u JOIN payments p ON p.user_id = u.id
      WHERE p.status = 'paid' AND p.amount_paise > 0 AND coalesce((p.raw->>'test_mode')::text, '') = ''
        AND NOT coalesce(u.is_internal, false) AND u.deactivated_at IS NULL`)).n;

  console.log(`\nPAYING CUSTOMERS WITHOUT A CONFIRMED EMAIL: ${rows.length} of ${total} paying customers`);
  console.log(`  ${unconfirmed.length} gave an email but never confirmed it · ${none.length} gave no email`);
  if (since) console.log(`  ${rows.filter((r) => r.on_new).length} of them have already written to the new WhatsApp number (ask them there — free)`);
  const line = (r) => `  ${tenOf(r.mobile)}  ${String(r.name || '—').slice(0, 18).padEnd(18)}  ${String(r.email || '').slice(0, 30).padEnd(30)}  `
    + `${String(r.paid_count).padStart(2)}× ₹${Math.round(Number(r.paid_paise) / 100)}  last ${ist(r.last_paid)}  ${String(r.last_vehicle || '').padEnd(11)}${r.on_new ? '  ✅ on new no.' : ''}`;
  if (unconfirmed.length) { console.log('\nNOT CONFIRMED (email given — one tap / code away):'); unconfirmed.forEach((r) => console.log(line(r))); }
  if (none.length) { console.log('\nNO EMAIL:'); none.forEach((r) => console.log(line(r))); }

  if (csv) {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    fs.writeFileSync(csv, 'mobile,name,email,status,paid_times,last_paid,last_vehicle,on_new_number\n'
      + rows.map((r) => [tenOf(r.mobile), q(r.name || ''), q(r.email || ''), r.email ? 'NOT CONFIRMED' : 'NO EMAIL',
        r.paid_count, ist(r.last_paid), r.last_vehicle || '', r.on_new ? 'yes' : 'no'].join(',')).join('\n') + '\n');
    console.log(`\nAlso written to ${csv}.`);
  }
  console.log('\nRead-only — nothing was sent.\n');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
