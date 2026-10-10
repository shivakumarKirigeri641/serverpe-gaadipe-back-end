/**
 * scripts/sms-notice.js — ONE SMS TO THE PEOPLE WHO USED GAADIPE ON WHATSAPP
 * (user, 2026-10-10: "I have around 270+ numbers including WhatsApp numbers, how
 * to deal with them?"). WhatsApp is gone; their account is the same on gaadipe.in.
 *
 * Who gets it, once each:
 *   paying   paid at least once and not deactivated
 *   agreed   agreed to the Terms (WhatsApp or website), never paid
 * Never: anyone who only said Hi, anyone who replied STOP, a blocked number, a
 * deactivated account, internal numbers, or anyone already sent this notice.
 *
 * Uses the approved DLT template sms_tpl_service (no values) and sms_alerts_enabled.
 *
 *   node scripts/sms-notice.js                    dry run: counts and a sample, nothing sent
 *   node scripts/sms-notice.js --send             send to both groups, one every 5 seconds
 *   node scripts/sms-notice.js --send --only paying
 *   node scripts/sms-notice.js --send --to 9886122415    one number only (a test to yourself)
 */
require('dotenv').config();
const db = require('../src/db');
const sms = require('../src/util/sms');

const args = process.argv.slice(2);
const live = args.includes('--send');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const to = args.includes('--to') ? String(args[args.indexOf('--to') + 1] || '').replace(/\D/g, '').slice(-10) : null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PEOPLE = `
  WITH agreed AS (
    SELECT DISTINCT right(regexp_replace(detail->>'mobile', '\\D', '', 'g'), 10) AS m
      FROM event_log WHERE kind = 'consent_accepted')
  SELECT u.id, right(u.mobile, 10) AS mobile,
         EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0) AS paying
    FROM users u JOIN agreed a ON a.m = right(u.mobile, 10)
   WHERE u.archived_at IS NULL AND u.deactivated_at IS NULL AND NOT coalesce(u.is_internal, false)
     AND u.mobile ~ '^[0-9]{10,12}$'
     AND NOT EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE right(s.mobile, 10) = right(u.mobile, 10) AND s.wa_opt_out_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM event_log e WHERE e.user_id = u.id AND e.kind = 'sms_service_notice')
   ORDER BY paying DESC, u.id`;

(async () => {
  let { rows } = await db.query(PEOPLE);
  const blocks = require('../src/admin/blocks');
  const keep = [];
  for (const r of rows) if (!(await blocks.isBlocked('mobile', r.mobile).catch(() => false))) keep.push(r);
  rows = keep.filter((r) => (only === 'paying' ? r.paying : only === 'agreed' ? !r.paying : true));
  if (to) rows = rows.filter((r) => r.mobile === to);

  const paying = rows.filter((r) => r.paying).length;
  console.log(`${live ? 'SENDING' : 'DRY RUN — nothing sent'}: ${rows.length} people (${paying} paying, ${rows.length - paying} agreed, not paying)${to ? ` — only ${to}` : ''}`);
  for (const r of rows.slice(0, 5)) console.log(`  ••••${r.mobile.slice(-4)}  ${r.paying ? 'paying' : 'agreed'}`);
  if (!live) {
    console.log('\nTemplate:', (await require('../src/util/settings').get('sms_tpl_service', '')) || '(not set — add the approved id in Settings: sms_tpl_service)');
    console.log('To send: node scripts/sms-notice.js --send   (try --send --to 9886122415 first)');
    process.exit(0);
  }
  let ok = 0; let failed = 0;
  for (const [i, r] of rows.entries()) {
    if (i) await wait(5000);
    const out = await sms.sendTemplate('service', r.mobile, []);
    if (out.ok) {
      ok += 1;
      await db.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'sms_service_notice', $2)`,
        [r.id, JSON.stringify({ mobile: r.mobile, paying: r.paying, simulated: Boolean(out.simulated) })]);
    } else failed += 1;
    console.log(`  ${i + 1}/${rows.length}  ••••${r.mobile.slice(-4)}  ${out.ok ? '✅ sent' : `❌ ${out.error}`}`);
    if (!out.ok && (out.skipped || /not configured|refused/i.test(String(out.error)))) { console.log('Stopping: SMS is not set up for this.'); break; }
  }
  console.log(`\nDone: ${ok} sent, ${failed} not sent.`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
