/**
 * scripts/templates-today.js — WHO GETS A WHATSAPP TEMPLATE TONIGHT (user, 2026-10-15: "how many
 * may get a template today?"). A forecast, read-only: nothing is sent, no provider is called.
 *
 *   node scripts/templates-today.js           counts, and each person (last 4 digits only)
 *   node scripts/templates-today.js --outside only those outside their 24-hour window — the
 *                                             templates, which count toward the 250 (2026-10-16)
 *
 * A template is what WhatsApp needs when the customer's 24-hour window is closed — and what
 * counts toward Meta's 250 a day. Inside the window the same words go as a free message.
 * Covers what is known before the evening: monitoring status updates, document-expiry warnings
 * and renewal reminders. Change alerts (a new challan, a document changed) depend on tonight's
 * checks, so they cannot be counted ahead — usually only a few.
 */
require('dotenv').config();
const db = require('../src/db');
const settings = require('../src/util/settings');
const send = require('../src/whatsapp/send');

const last4 = (m) => `••${String(m || '').slice(-4)}`;

(async () => {
  const on = (k, d) => settings.bool(k, d);
  const from = await settings.num('alert_send_hour_ist', 19);
  const until = await settings.num('alert_send_until_hour_ist', 22);
  console.log(`WhatsApp sending: ${await on('whatsapp_sending_enabled', false) ? 'ON' : 'OFF'} · status updates: ${await on('watch_daily_status_enabled', false) ? 'ON' : 'OFF'}`
    + ` · expiry warnings: ${String(await settings.get('expiry_warnings_enabled', 'true')) === 'false' ? 'OFF' : 'ON'} · window ${from}:00–${until}:00 IST`);
  const pausedAt = Date.parse(String(await settings.get('whatsapp_templates_paused_until', '') || ''));
  if (pausedAt > Date.now()) console.log(`⚠️  Templates paused until ${new Date(pausedAt).toISOString()} (spam brake) — none will go before then.`);

  const people = new Map();   // mobile → what they get
  const add = (m, what, how) => {
    if (!people.has(m)) people.set(m, { what: [], template: false });
    const p = people.get(m);
    p.what.push(`${what}: ${how}`);
    if (how === 'template') p.template = true;
  };
  const howOnWa = async (m) => ((await send.optedOut(m).catch(() => true)) ? 'off (STOP)'
    : (await send.windowOpen(m).catch(() => false)) ? 'free message (window open)' : 'template');

  // 1. Monitoring status updates (jobs/watch.js — the job's own dry run).
  const st = await require('../src/jobs/watch').dailyStatus({ dryRun: true });
  if (st.dryRun) {
    for (const w of st.would) {
      const u = await db.one(`SELECT mobile FROM users WHERE id = $1`, [Number(w.user_id)]);
      add(u?.mobile || w.mobile, `status update (${w.vehicles.join(', ')})`, w.whatsapp);
    }
  } else {
    console.log('Status updates: off — none tonight.');
  }

  // 2. Document-expiry warnings owed (jobs/expiryWatch.js) — before tonight's re-check of the dates.
  if (String(await settings.get('expiry_warnings_enabled', 'true')) !== 'false') {
    const E = require('../src/jobs/expiryWatch');
    const list = await E.thresholds();
    for (const row of await E.candidates(200)) {
      const owed = await E.owedAll(row, list);
      if (owed.length) add(row.mobile, `expiry warning ${row.reg_no} (${owed.map((o) => o.doc.label).join(', ')})`, await howOnWa(row.mobile));
    }
  }

  // 3. Renewal reminders (jobs/renewal.js): a template only once wa_template_renewal is set.
  const R = require('../src/jobs/renewal');
  const tpl = String(await settings.get('wa_template_renewal', '') || '').trim();
  for (const r of await R.due(200)) {
    const how = await howOnWa(r.mobile);
    add(r.mobile, `renewal ${r.reg_no} (ends ${String(r.ends_on).slice(0, 10)})`, how === 'template' && !tpl ? 'not on WhatsApp (no renewal template yet)' : how);
  }

  const all = [...people.entries()];
  const templ = all.filter(([, p]) => p.template).length;
  console.log(`\n${all.length} customer(s) due something tonight · ${templ} would need a TEMPLATE (counts toward the 250), `
    + `${all.length - templ} free message or other channel.\n`);
  // --outside: only the templates — people outside their 24-hour window (user, 2026-10-16).
  const outside = process.argv.includes('--outside');
  if (outside) console.log('Only those outside their 24-hour window (they get the template):\n');
  for (const [m, p] of all) {
    if (outside && !p.template) continue;
    console.log(`${p.template ? '📨' : '💬'} ${last4(m)}  ${p.what.join(' · ')}`);
  }
  console.log('\nPlus change alerts (new challan, a changed document) found by tonight\'s checks — not knowable ahead.');
  console.log('Each customer is counted once toward the limit however many messages they get.');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
