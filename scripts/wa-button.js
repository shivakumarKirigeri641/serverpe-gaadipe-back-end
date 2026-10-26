/**
 * scripts/wa-button.js — WHAT GAADIPE.IN SAYS ABOUT WHATSAPP, SWITCHED AT ONCE (user, 2026-10-23: "if WhatsApp
 * is disabled, you need a quick script to hide the button"; "remove 'GaadiPe is now fully on the web'").
 * The site reads these from /notice (cached up to a minute) — no build, no upload, no restart.
 *
 *   node scripts/wa-button.js off        "Check a vehicle" opens the web chat
 *   node scripts/wa-button.js on         "Check a vehicle" opens WhatsApp (since 2026-10-26; was a separate
 *                                        "Try in WhatsApp" button)
 *   node scripts/wa-button.js web-only   WhatsApp disabled: hide the button AND show "GaadiPe is now fully
 *                                        on the web" (the yellow sign and the green top bar)
 *   node scripts/wa-button.js whatsapp   WhatsApp live: show the button, hide the "fully on the web" notices
 *   node scripts/wa-button.js            what is on now
 *
 * Only the website's words and button. The bot itself: node scripts/wa-golive.js off | live.
 */
require('dotenv').config();
const db = require('../src/db');

const set = (key, value) => db.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [key, value]);
const PLAN = {
  on: { site_whatsapp_try: 'true' },
  off: { site_whatsapp_try: 'false' },
  'web-only': { site_whatsapp_try: 'false', site_moved_notice: 'true', site_notice_on: 'true' },
  whatsapp: { site_whatsapp_try: 'true', site_moved_notice: 'false', site_notice_on: 'false' },
};

const cmd = (process.argv[2] || 'status').toLowerCase();
(async () => {
  if (PLAN[cmd]) for (const [k, v] of Object.entries(PLAN[cmd])) await set(k, v);
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key IN ('site_whatsapp_try', 'site_moved_notice', 'site_notice_on')`);
  const v = (k, d) => { const r = rows.find((x) => x.key === k); return r ? /^(1|true|yes|on)$/i.test(String(r.value)) : d; };
  // Since 2026-10-26 this switch sends every "Check a vehicle" on gaadipe.in to WhatsApp (no separate button).
  console.log(`"Check a vehicle" opens             ${v('site_whatsapp_try', true) ? 'WHATSAPP (+91 79960 83415)' : 'the web chat'}`);
  console.log(`"Fully on the web" yellow sign      ${v('site_moved_notice', false) ? 'SHOWN' : 'hidden'}`);
  console.log(`Green top bar (site notice)         ${v('site_notice_on', false) ? 'SHOWN' : 'hidden'}`);
  if (PLAN[cmd]) console.log('\nVisitors see the change within a minute (refresh once).');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
