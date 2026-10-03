/**
 * src/jobs/vahanWatch.js — is ULIP's VAHAN up? (user, 2026-10-03)
 *
 * Every 15 minutes, one RC lookup straight to ULIP — no cache, never the paid
 * backup, free — for a vehicle known to exist (setting vahan_probe_reg, else
 * the last vehicle a customer checked successfully). Without it nobody knew
 * VAHAN had recovered until a customer happened to check.
 *
 *   down → up   "VAHAN is back" to the admin (panel, WhatsApp, push), the open
 *               alert cleared, and the waiting list run at once
 *   up → down   an alert: customers are being served by the RC backup, or
 *               saved for later
 *
 * A single odd answer is not an outage: two probes in a row must agree before
 * the state flips. The state lives in app_settings (vahan_watch).
 */

const db = require('../db');
const settings = require('../util/settings');
const status = require('../util/providerStatus');

async function probeReg() {
  const set = String(await settings.get('vahan_probe_reg', '') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (set) return set;
  const row = await db.one(
    `SELECT v.reg_no FROM vehicle_snapshots s JOIN vehicles v ON v.id = s.vehicle_id
      WHERE s.dataset = 'rc' AND s.data->>'maker' IS NOT NULL ORDER BY s.fetched_at DESC LIMIT 1`).catch(() => null);
  return row?.reg_no || null;
}

async function read() { return JSON.parse(await settings.get('vahan_watch', 'null') || 'null') || { state: 'unknown', streak: 0 }; }
async function save(w) {
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ('vahan_watch', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [JSON.stringify(w)]);
  settings.refresh();
}

let running = false;
async function tick() {
  if (running) return null;
  running = true;
  try {
    const reg = await probeReg();
    if (!reg) return null;
    const t0 = Date.now();
    const r = await require('../ulip/vahan').fetchRc(reg, { noBackup: true });
    const up = Boolean(r.ok || r.notFound);
    status.record('vahan', { ok: up, ms: Date.now() - t0, error: up ? null : `${(r.calls || []).map((c) => c.code).join(' / ')} (watchdog)` });

    const w = await read();
    const seen = up ? 'up' : 'down';
    w.streak = w.last === seen ? (w.streak || 0) + 1 : 1;
    w.last = seen; w.checked_at = new Date().toISOString(); w.reg = reg;
    const flip = w.state !== seen && (w.streak >= 2 || w.state === 'unknown');
    if (flip) {
      const was = w.state;
      w.state = seen; w.since = w.checked_at;
      await save(w);
      if (seen === 'up' && was === 'down') await back();
      if (seen === 'down') await down(r);
    } else {
      await save(w);
    }
    return w;
  } catch (e) {
    console.error('[vahan-watch]', e.message);
    return null;
  } finally {
    running = false;
  }
}

async function back() {
  console.log('[vahan-watch] VAHAN is back');
  await require('../admin/alerts').clear('vahan_down', 'VAHAN answered the watchdog again').catch(() => {});
  const waiting = await db.one(`SELECT count(*)::int AS n FROM lookup_waitlist WHERE status = 'waiting'`).catch(() => ({ n: 0 }));
  await require('../util/adminPing').ping({
    key: 'vahan_back', alert: false, severity: 'info', source: 'vehicle_api',
    title: '✅ VAHAN is back',
    text: `ULIP's VAHAN is answering again, so vehicle checks use it (free) instead of the paid RC backup.${waiting?.n ? ` Sending the ${waiting.n} waiting check${waiting.n === 1 ? '' : 's'} now.` : ''}`,
  });
  // Waiting customers get their checks now, not at the next five-minute pass.
  require('./waitlist').tick().catch(() => {});
}

async function down(r) {
  console.log('[vahan-watch] VAHAN is down');
  const backupOn = await require('../vehicle/rcBackup').enabled().catch(() => false);
  await require('../util/adminPing').ping({
    key: 'vahan_down', severity: 'critical', source: 'vehicle_api',
    title: '⚠️ VAHAN is down',
    text: `ULIP's VAHAN is not answering (${(r.calls || []).map((c) => `${c.path} ${c.code}`).join(', ') || 'no answer'}). `
      + (backupOn ? 'Customers are being served by the paid RC backup.' : 'The RC backup is OFF — customers are being saved to the waiting list. Switch it on in Feature flags if you want them served now.'),
  });
}

/** For the panel: the watchdog's last word. */
const state = () => read();

function start(everySeconds = 900) {
  setTimeout(tick, 90 * 1000).unref();
  setInterval(tick, everySeconds * 1000).unref();
  console.log(`  vahan watch: every ${everySeconds}s`);
}

module.exports = { start, tick, state };
