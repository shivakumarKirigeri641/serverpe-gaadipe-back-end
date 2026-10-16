/**
 * scripts/summary-preview.js — WHAT THE 11:55 PM SUMMARY WOULD SAY NOW (user, 2026-10-16: "the
 * summary at 11:55 pm showed all zeros"). Read-only: sends nothing. Prints today's and yesterday's
 * figures as the summary computes them (insights.compare, WhatsApp), then the raw counts behind
 * them, so a zero can be traced to its cause.
 *
 *   node scripts/summary-preview.js            daily_summary_channel (whatsapp by default)
 *   node scripts/summary-preview.js all        every channel
 */
require('dotenv').config();
const db = require('../src/db');
const settings = require('../src/util/settings');

(async () => {
  const channel = (process.argv[2] || String(await settings.get('daily_summary_channel', 'whatsapp'))).toLowerCase();
  const c = (await require('../src/admin/insights').compare({ channel })).day;
  const f = (x) => `payments ${x.payments} · revenue Rs.${(x.gross_paise / 100).toFixed(0)} · checks ${x.checks} · people checking ${x.active_users}`
    + ` · new customers ${x.new_users} · reports ${x.reports} · abandoned ${x.abandoned}`;
  console.log(`Channel: ${channel}`);
  console.log(`Today so far : ${f(c.current)}`);
  console.log(`Yesterday    : ${f(c.previous_full)}`);

  const DAY = `date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`;
  const raw = await db.one(`
    SELECT
      (SELECT count(*) FROM event_log WHERE kind = 'vehicle_check' AND created_at >= ${DAY} - interval '1 day')::int AS checks_2days_all,
      (SELECT count(*) FROM payments WHERE status = 'paid' AND paid_at >= ${DAY} - interval '1 day')::int AS paid_2days_all,
      (SELECT count(*) FROM payments WHERE status = 'paid' AND paid_at >= ${DAY} - interval '1 day' AND raw->>'channel' IS NULL)::int AS paid_no_channel,
      (SELECT count(*) FROM payments WHERE status = 'paid' AND paid_at >= ${DAY} - interval '1 day' AND raw->'paid_from'->>'channel' = 'web')::int AS paid_from_browser,
      (SELECT count(*) FROM schema_migrations WHERE name LIKE '191%')::int AS migration_191`).catch(async () => db.one(`
    SELECT
      (SELECT count(*) FROM event_log WHERE kind = 'vehicle_check' AND created_at >= ${DAY} - interval '1 day')::int AS checks_2days_all,
      (SELECT count(*) FROM payments WHERE status = 'paid' AND paid_at >= ${DAY} - interval '1 day')::int AS paid_2days_all,
      (SELECT count(*) FROM payments WHERE status = 'paid' AND paid_at >= ${DAY} - interval '1 day' AND raw->>'channel' IS NULL)::int AS paid_no_channel,
      (SELECT count(*) FROM payments WHERE status = 'paid' AND paid_at >= ${DAY} - interval '1 day' AND raw->'paid_from'->>'channel' = 'web')::int AS paid_from_browser`));
  console.log('\nRaw, yesterday + today, every channel:');
  console.log(`  vehicle checks ${raw.checks_2days_all} · paid payments ${raw.paid_2days_all}`
    + ` · of them with no channel of their own ${raw.paid_no_channel} · paid in a browser ${raw.paid_from_browser}`);
  if (raw.paid_no_channel) console.log('  → payments without a channel: migration 191 has not run yet (npm run migrate). Until it does, WhatsApp payments count as website ones.');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
