/**
 * scripts/send-alerts.js — THE MONITORING ALERT TO EACH CUSTOMER FROM since-list.js, 2-5 MINUTES APART
 * (user, 2026-10-27: "give script to send each with random of 2-5 min gap"). About their OWN vehicle: its nearest
 * document date. Dry run by default - nothing is sent without --send.
 *
 *   node scripts/send-alerts.js                     dry run: who would get what (masked numbers)
 *   node scripts/send-alerts.js --limit 50 --send   really send, 2-5 min apart
 *   --from 2026-10-23                               joined from this IST date (default), up to 24 hours ago
 *
 * The template is the monitoring alert the alert jobs use (setting wa_template_monitoring; whatsapp/monitorAlert.js):
 * name, vehicle, document, expiry date, status, and its three buttons (Thanks / Check vehicle / Pause this alert),
 * handled by the bot as for any alert. It must be UTILITY, or nothing is sent.
 *
 * Every send goes through send.template, so all its guards hold (STOP, Terms, flagged wording, the spam brake).
 * Before each: send.mayStart (WhatsApp on, wrote to the new number, agreed, not STOP, templates not paused) and the
 * number's quality - anything but GREEN stops the run. Anyone sent this template in the last 7 days is skipped, so a
 * stopped run can simply be started again. Ctrl+C stops it at once.
 */
require('dotenv').config();
const db = require('../src/db');
const settings = require('../src/util/settings');
const send = require('../src/whatsapp/send');
const { sendAlert } = require('../src/whatsapp/monitorAlert');

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const SEND = process.argv.includes('--send');
const FROM = /^\d{4}-\d{2}-\d{2}$/.test(arg('from', '')) ? arg('from') : '2026-10-23';
const LIMIT = Math.max(1, Math.min(200, Number(arg('limit', 50)) || 50));

const DOCS = [['insurance_upto', 'insurance', 'Insurance'], ['pucc_upto', 'pucc', 'PUC'], ['tax_upto', 'tax', 'Road tax'], ['fitness_upto', 'fitness', 'Fitness']];
const day = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const mask = (m) => `••••••${String(m).slice(-4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The document due soonest (an expired one first) - what the alert is about. */
function nearest(rc) {
  const all = DOCS.map(([k, key, label]) => ({ key, label, at: rc?.[k] ? new Date(rc[k]) : null }))
    .filter((x) => x.at && !Number.isNaN(x.at.getTime()))
    .sort((a, b) => a.at - b.at);
  if (!all.length) return null;
  const d = all[0];
  const days = Math.ceil((d.at - Date.now()) / 86400000);
  const status = days < 0 ? `Expired ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'Expires today'
    : `Expires in ${days} day${days === 1 ? '' : 's'}`;
  return { key: d.key, document: d.label, expiry: day(d.at), status };
}

(async () => {
  const tpl = String(await settings.get('wa_template_monitoring', '') || '').trim();
  if (!tpl) { console.log('\nNo monitoring template set (wa_template_monitoring). Nothing sent.\n'); process.exit(1); }
  const category = await send.categoryOf(tpl);
  if (category !== 'UTILITY') { console.log(`\n${tpl} is ${category || 'unknown'}, not UTILITY - refused.\n`); process.exit(1); }

  const { rows } = await db.query(
    `SELECT u.id, u.mobile, coalesce(nullif(u.display_name, ''), nullif(u.wa_profile_name, ''), 'there') AS name,
            v.id AS vehicle_id, v.reg_no, s.data AS rc
       FROM users u
       JOIN LATERAL (SELECT uv.vehicle_id FROM user_vehicles uv WHERE uv.user_id = u.id AND uv.hidden_at IS NULL
                      ORDER BY uv.last_checked_at DESC NULLS LAST LIMIT 1) last ON true
       JOIN vehicles v ON v.id = last.vehicle_id
       LEFT JOIN vehicle_snapshots s ON s.vehicle_id = v.id AND s.dataset = 'rc'
      WHERE u.deactivated_at IS NULL AND coalesce(u.is_internal, false) = false
        AND u.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
        AND u.created_at < now() - interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM whatsapp_sessions ws WHERE ws.mobile = u.mobile AND ws.last_inbound_at > now() - interval '24 hours')
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.kind = 'mobile' AND b.value = u.mobile AND b.released_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM vehicle_reports r WHERE r.user_id = u.id AND r.valid_until > now())
        AND NOT EXISTS (SELECT 1 FROM subscriptions sb WHERE sb.user_id = u.id AND sb.is_active AND sb.ends_on >= CURRENT_DATE)
        AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.mobile = u.mobile AND m.direction = 'out'
                         AND m.template_name = $2 AND m.error_message IS NULL AND m.created_at > now() - interval '7 days')
      ORDER BY u.created_at
      LIMIT $3`, [FROM, tpl, LIMIT]);

  console.log(`\n${SEND ? 'SENDING' : 'DRY RUN (nothing sent)'} · ${tpl} (${category}) · ${rows.length} customer${rows.length === 1 ? '' : 's'} · 2-5 min apart\n`);
  let sent = 0; let skipped = 0;
  for (const [i, r] of rows.entries()) {
    const due = nearest(r.rc);
    if (!due) { console.log(`  ${i + 1}. ${mask(r.mobile)} ${r.reg_no} - no document dates saved, skipped`); skipped += 1; continue; }
    const first = String(r.name).split(/\s+/)[0].slice(0, 30);
    const may = await send.mayStart(r.mobile);
    if (!may.ok) {
      console.log(`  ${i + 1}. ${mask(r.mobile)} ${r.reg_no} - skipped (${may.why})`); skipped += 1;
      if (['whatsapp_off', 'templates_paused'].includes(may.why)) break;
      continue;
    }
    if (!SEND) { console.log(`  ${i + 1}. ${mask(r.mobile)} would get: ${first} | ${r.reg_no} | ${due.document} | ${due.expiry} | ${due.status}`); continue; }

    const q = await send.qualityRating().catch(() => null);
    if (q && q !== 'GREEN') { console.log(`\n  Quality is ${q} - stopped. ${sent} sent.\n`); break; }
    const out = await sendAlert(r.mobile, { name: first, vehicle: r.reg_no, vehicleId: r.vehicle_id, document: due.document,
      expiry: due.expiry, status: due.status, kind: 'exp', docs: [due.key] }).catch((e) => ({ ok: false, error: e.message }));
    const at = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    if (out.ok) { sent += 1; console.log(`  ${i + 1}. ${at} ${mask(r.mobile)} ${r.reg_no} - sent (${due.document} ${due.status})`); }
    else { skipped += 1; console.log(`  ${i + 1}. ${at} ${mask(r.mobile)} ${r.reg_no} - NOT sent: ${out.error || 'refused'}`); }
    const brake = await send.mayStart(r.mobile).catch(() => ({ ok: false, why: 'unknown' }));
    if (['whatsapp_off', 'templates_paused'].includes(brake.why)) { console.log('\n  WhatsApp is off or templates are paused (the spam brake) - stopped.\n'); break; }
    if (i < rows.length - 1) {
      const wait = 120000 + Math.floor(Math.random() * 180000);
      console.log(`     next in ${(wait / 60000).toFixed(1)} min`);
      await sleep(wait);
    }
  }
  console.log(`\n${SEND ? `Sent ${sent}` : 'Dry run'} · skipped ${skipped}.${SEND ? '' : ' Add --send to send.'}\n`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
