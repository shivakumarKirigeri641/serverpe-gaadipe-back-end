/**
 * scripts/send-alerts.js — ONE UTILITY TEMPLATE TO EACH CUSTOMER FROM since-list.js, 2-5 MINUTES APART
 * (user, 2026-10-27: "give script to send each with random of 2-5 min gap"). About their OWN vehicle: its
 * nearest document date. Dry run by default - nothing is sent without --send.
 *
 *   node scripts/send-alerts.js --template gp_xxx_v1 --params name,vehicle,document,date,status
 *   node scripts/send-alerts.js --template gp_xxx_v1 --params name,vehicle,document,date,status --limit 50 --send
 *
 *   --template   the approved UTILITY template's name (anything else is refused)
 *   --params     what fills {{1}}, {{2}}, … in order, from: name, vehicle, document, date, status, days
 *   --lang       template language (default en)
 *   --from       joined from this IST date (default 2026-10-23); up to 24 hours ago, as since-list.js
 *   --limit      at most this many (default 50)
 *   --send       really send; without it, prints what each would get (masked numbers) and sends nothing
 *
 * Every send goes through whatsapp/send.template, so all its guards hold (STOP, Terms, flagged wording, the
 * spam brake). Before each one: send.mayStart (WhatsApp on, wrote to the new number, agreed, not STOP, templates
 * not paused) and the number's quality - anything but GREEN stops the run. Anyone sent this template in the last
 * 7 days is skipped, so a stopped run can be started again. Ctrl+C stops it at once.
 */
require('dotenv').config();
const db = require('../src/db');
const send = require('../src/whatsapp/send');

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const SEND = process.argv.includes('--send');
const NAME = arg('template');
const PARAMS = String(arg('params', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const LANG = arg('lang', 'en');
const FROM = /^\d{4}-\d{2}-\d{2}$/.test(arg('from', '')) ? arg('from') : '2026-10-23';
const LIMIT = Math.max(1, Math.min(200, Number(arg('limit', 50)) || 50));
const KNOWN = ['name', 'vehicle', 'document', 'date', 'status', 'days'];

const DOCS = [['insurance_upto', 'Insurance'], ['pucc_upto', 'PUC'], ['tax_upto', 'Road tax'], ['fitness_upto', 'Fitness']];
const day = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const mask = (m) => `••••••${String(m).slice(-4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The document due soonest (an expired one first) - what the alert is about. */
function nearest(rc) {
  const now = Date.now();
  const all = DOCS.map(([k, label]) => ({ label, at: rc?.[k] ? new Date(rc[k]) : null }))
    .filter((x) => x.at && !Number.isNaN(x.at.getTime()))
    .sort((a, b) => a.at - b.at);
  if (!all.length) return null;
  const d = all[0];
  const days = Math.ceil((d.at - now) / 86400000);
  const status = days < 0 ? `Expired ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'Expires today'
    : `Expires in ${days} day${days === 1 ? '' : 's'}`;
  return { document: d.label, date: day(d.at), status, days: String(days) };
}

(async () => {
  if (!NAME || !PARAMS.length || PARAMS.some((p) => !KNOWN.includes(p))) {
    console.log(`usage: node scripts/send-alerts.js --template NAME --params ${KNOWN.join(',')} [--limit 50] [--send]`);
    process.exit(1);
  }
  const category = await send.categoryOf(NAME);
  if (category !== 'UTILITY') { console.log(`\n${NAME} is ${category || 'unknown'}, not UTILITY - refused.\n`); process.exit(1); }
  const vars = await send._varCount(NAME);
  if (vars != null && vars !== PARAMS.length) {
    console.log(`\n${NAME} has ${vars} blanks; --params gives ${PARAMS.length}. Nothing sent.\n`); process.exit(1);
  }

  const { rows } = await db.query(
    `SELECT u.id, u.mobile, coalesce(nullif(u.display_name, ''), nullif(u.wa_profile_name, ''), 'Customer') AS name,
            v.reg_no, s.data AS rc
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
      LIMIT $3`, [FROM, NAME, LIMIT]);

  console.log(`\n${SEND ? 'SENDING' : 'DRY RUN (nothing sent)'} · ${NAME} (${category}) · ${rows.length} customer${rows.length === 1 ? '' : 's'} · 2-5 min apart\n`);
  let sent = 0; let skipped = 0;
  for (const [i, r] of rows.entries()) {
    const due = nearest(r.rc);
    if (!due) { console.log(`  ${i + 1}. ${mask(r.mobile)} ${r.reg_no} - no document dates saved, skipped`); skipped += 1; continue; }
    const fill = { name: String(r.name).split(/\s+/)[0].slice(0, 30), vehicle: r.reg_no, ...due };
    const params = PARAMS.map((p) => fill[p]);
    const may = await send.mayStart(r.mobile);
    if (!may.ok) { console.log(`  ${i + 1}. ${mask(r.mobile)} ${r.reg_no} - skipped (${may.why})`); skipped += 1;
      if (['whatsapp_off', 'templates_paused'].includes(may.why)) break; continue; }
    if (!SEND) { console.log(`  ${i + 1}. ${mask(r.mobile)} would get: ${params.join(' | ')}`); continue; }

    const q = await send.qualityRating().catch(() => null);
    if (q && q !== 'GREEN') { console.log(`\n  Quality is ${q} - stopped. ${sent} sent.\n`); break; }
    const out = await send.template(r.mobile, NAME, params, { language: LANG }).catch((e) => ({ ok: false, error: e.message }));
    const at = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    if (out.ok) { sent += 1; console.log(`  ${i + 1}. ${at} ${mask(r.mobile)} ${r.reg_no} - sent (${fill.document} ${fill.status})`); }
    else { skipped += 1; console.log(`  ${i + 1}. ${at} ${mask(r.mobile)} ${r.reg_no} - NOT sent: ${out.error || 'refused'}`); }
    if (await send.mayStart(r.mobile).then((m) => m.why === 'whatsapp_off' || m.why === 'templates_paused').catch(() => false)) {
      console.log('\n  WhatsApp is off or templates are paused (the spam brake) - stopped.\n'); break;
    }
    if (i < rows.length - 1) {
      const wait = 120000 + Math.floor(Math.random() * 180000);
      console.log(`     next in ${Math.round(wait / 60000 * 10) / 10} min`);
      await sleep(wait);
    }
  }
  console.log(`\n${SEND ? `Sent ${sent}` : 'Dry run'} · skipped ${skipped}.${SEND ? '' : ' Add --send to send.'}\n`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
