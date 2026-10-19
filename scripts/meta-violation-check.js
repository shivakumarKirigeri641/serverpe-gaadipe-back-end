/**
 * scripts/meta-violation-check.js — WHY DID META SAY "ALCOHOL"? (user, 2026-10-19: the WhatsApp
 * account disabled for a policy violation of type ALCOHOL). Read-only, sends nothing:
 *
 *   1. Meta's own account notices the webhook saved (event_log meta_account_news), last 21 days
 *   2. alcohol / drink-driving wording in the reports GaadiPe issued (their saved challan data —
 *      the PDF prints each challan's offence), last 30 days
 *   3. the same wording in WhatsApp messages, sent and received, last 30 days
 *
 *   node scripts/meta-violation-check.js
 */
require('dotenv').config();
const db = require('../src/db');

const WORDS = `(drunk|drunken|alcohol|liquor|intoxicat|influence of (drink|liquor|alcohol|drug)|sharab|daru|beer|wine|whisky|vodka|bar ?& ?restaurant|शराब|नशे)`;
const tail = (m) => `••${String(m || '').slice(-4)}`;
const ist = (t) => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

(async () => {
  const news = await db.query(
    `SELECT created_at, detail FROM event_log WHERE kind = 'meta_account_news' AND created_at > now() - interval '21 days'
      ORDER BY id DESC LIMIT 30`);
  console.log(`1. Meta account notices (last 21 days): ${news.rows.length}`);
  for (const r of news.rows) console.log(`   ${ist(r.created_at)}  ${r.detail.field}: ${JSON.stringify(r.detail.value).slice(0, 220)}`);

  const reps = await db.query(
    `SELECT r.report_number, r.reg_no, r.created_at, r.channel, u.mobile,
            substring(r.snapshot::text from '(?i)[^"]{0,60}${WORDS}[^"]{0,60}') AS hit
       FROM vehicle_reports r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.created_at > now() - interval '30 days' AND r.snapshot::text ~* '${WORDS}'
      ORDER BY r.created_at DESC LIMIT 50`);
  console.log(`\n2. Reports whose challans mention alcohol / drink-driving (last 30 days): ${reps.rows.length}`);
  for (const r of reps.rows) console.log(`   ${ist(r.created_at)}  ${r.report_number}  ${r.reg_no}  ${r.channel}  ${tail(r.mobile)}  “${String(r.hit || '').slice(0, 120)}”`);

  const msgs = await db.query(
    `SELECT created_at, direction, mobile, message_type, left(body, 160) AS body
       FROM whatsapp_messages WHERE created_at > now() - interval '30 days' AND body ~* '${WORDS}'
      ORDER BY id DESC LIMIT 50`);
  console.log(`\n3. WhatsApp messages with those words (last 30 days): ${msgs.rows.length}`);
  for (const m of msgs.rows) console.log(`   ${ist(m.created_at)}  ${m.direction === 'out' ? 'SENT    ' : 'received'}  ${tail(m.mobile)}  ${m.message_type}  “${String(m.body || '').replace(/\s+/g, ' ')}”`);

  console.log('\nRead-only — nothing was sent.');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
