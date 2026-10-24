/**
 * scripts/tonight.js — WHO GETS WHAT THIS EVENING (user, 2026-10-24: "I want to know today how many will get
 * templates"). Read-only: sends nothing, calls no provider, writes nothing.
 *
 *   node scripts/tonight.js
 *
 * The evening jobs (7–10 pm IST) and what each person due would get on WhatsApp:
 *   renewal    monitoring ending within renewal_notice_days, not yet told   (jobs/renewal.due)
 *   expiry     a document at its 30/7/1-day step, not yet warned           (jobs/expiryWatch.candidates + owedAll)
 *   digest     new challans / changes found, not yet sent                  (pending_alerts)
 * For each: "free message" (inside their 24-hour window), "TEMPLATE" (outside it, may be started), or why
 * WhatsApp is skipped (send.mayStart: not on the new number, not agreed, STOP, paused). SMS and email go by their
 * own rules either way. Numbers shown as the last 4 digits only.
 */
require('dotenv').config();
const db = require('../src/db');
const send = require('../src/whatsapp/send');

const last4 = (m) => `••${String(m || '').replace(/\D/g, '').slice(-4)}`;

async function verdict(mobile) {
  if (await send.windowOpen(mobile).catch(() => false)) return 'free message (24 h window)';
  const may = await send.mayStart(mobile).catch((e) => ({ ok: false, why: e.message }));
  return may.ok ? 'TEMPLATE' : `no WhatsApp (${may.why})`;
}

(async () => {
  const rows = [];

  const renewal = await require('../src/jobs/renewal').due(500);
  for (const r of renewal) rows.push({ job: 'renewal', who: last4(r.mobile), vehicle: r.reg_no, mobile: r.mobile });

  const ew = require('../src/jobs/expiryWatch');
  const list = await ew.thresholds();
  for (const r of await ew.candidates(500)) {
    const owed = await ew.owedAll(r, list).catch(() => []);
    if (owed.length) rows.push({ job: 'expiry', who: last4(r.mobile), vehicle: r.reg_no, mobile: r.mobile });
  }

  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const { rows: digest } = await db.query(
    `SELECT u.mobile, string_agg(DISTINCT p.reg_no, ', ') AS reg_no
       FROM pending_alerts p JOIN users u ON u.id = p.user_id
      WHERE p.sent_at IS NULL AND NOT u.is_paused
        AND NOT EXISTS (SELECT 1 FROM event_log e WHERE e.user_id = p.user_id AND e.kind = 'watch_digest'
                          AND e.detail->>'ist_date' = $1)
      GROUP BY u.mobile`, [today]).catch(() => ({ rows: [] }));
  for (const r of digest) rows.push({ job: 'digest', who: last4(r.mobile), vehicle: r.reg_no, mobile: r.mobile });

  for (const r of rows) { r.whatsapp = await verdict(r.mobile); delete r.mobile; }
  if (rows.length) console.table(rows); else console.log('Nobody is due tonight.');

  const templates = rows.filter((r) => r.whatsapp === 'TEMPLATE').length;
  const free = rows.filter((r) => r.whatsapp.startsWith('free')).length;
  console.log(`\nTonight: ${rows.length} due · ${templates} template(s) · ${free} free message(s) · ${rows.length - templates - free} not on WhatsApp`);
  console.log('Report-ready templates are not in this list: they go only right after a payment.');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
