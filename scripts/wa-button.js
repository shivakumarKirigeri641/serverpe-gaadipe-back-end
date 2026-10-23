/**
 * scripts/wa-button.js — SHOW OR HIDE "TRY IN WHATSAPP" ON GAADIPE.IN, AT ONCE (user, 2026-10-23: "if WhatsApp
 * is disabled, you need a quick script to hide the button"). Flips site_whatsapp_try; the site reads it from
 * /notice (cached up to a minute) — no build, no upload, no restart.
 *
 *   node scripts/wa-button.js off      hide the button (WhatsApp disabled or paused)
 *   node scripts/wa-button.js on       show it again
 *   node scripts/wa-button.js          what it is now
 *
 * It only hides the website's button. To stop the bot itself: node scripts/wa-golive.js off.
 */
require('dotenv').config();
const db = require('../src/db');

const cmd = (process.argv[2] || 'status').toLowerCase();
(async () => {
  if (cmd === 'on' || cmd === 'off') {
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('site_whatsapp_try', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [cmd === 'on' ? 'true' : 'false']);
  }
  const row = await db.one(`SELECT value FROM app_settings WHERE key = 'site_whatsapp_try'`).catch(() => null);
  const shown = !row || /^(1|true|yes|on)$/i.test(String(row.value));
  console.log(`"Try in WhatsApp" on gaadipe.in: ${shown ? 'SHOWN' : 'HIDDEN'}${cmd === 'on' || cmd === 'off' ? ' — visitors see the change within a minute (refresh once).' : ''}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
