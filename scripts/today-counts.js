/**
 * scripts/today-counts.js — WHAT REALLY HAPPENED TODAY AND YESTERDAY (user, 2026-10-21: "web admin shows
 * customers 0 today vs 0 yesterday — is that an issue? check everywhere"). Read-only: counts straight from
 * the tables the admin's cards read, by IST day, so a 0 on a card can be told apart from a 0 in reality.
 *
 *   node scripts/today-counts.js
 */
require('dotenv').config();
const db = require('../src/db');

const DAY = `date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`;
const ROWS = [
  ['New accounts (website sign-up)', `SELECT count(*) FILTER (WHERE created_at >= ${DAY}) AS t, count(*) FILTER (WHERE created_at >= ${DAY} - interval '1 day' AND created_at < ${DAY}) AS y FROM users WHERE signup_channel = 'web' AND NOT coalesce(is_internal, false)`],
  ['New accounts (any channel)', `SELECT count(*) FILTER (WHERE created_at >= ${DAY}) AS t, count(*) FILTER (WHERE created_at >= ${DAY} - interval '1 day' AND created_at < ${DAY}) AS y FROM users WHERE NOT coalesce(is_internal, false)`],
  ['Website sign-ins (OTP done)', `SELECT count(*) FILTER (WHERE created_at >= ${DAY}) AS t, count(*) FILTER (WHERE created_at >= ${DAY} - interval '1 day' AND created_at < ${DAY}) AS y FROM site_sign_ins WHERE event = 'signed_in'`],
  ['  of them, different people', `SELECT count(DISTINCT user_id) FILTER (WHERE created_at >= ${DAY}) AS t, count(DISTINCT user_id) FILTER (WHERE created_at >= ${DAY} - interval '1 day' AND created_at < ${DAY}) AS y FROM site_sign_ins WHERE event = 'signed_in'`],
  ['Free checks before sign-in', `SELECT count(*) FILTER (WHERE created_at >= ${DAY}) AS t, count(*) FILTER (WHERE created_at >= ${DAY} - interval '1 day' AND created_at < ${DAY}) AS y FROM anon_checks`],
  ['Checks while signed in (web)', `SELECT count(*) FILTER (WHERE created_at >= ${DAY}) AS t, count(*) FILTER (WHERE created_at >= ${DAY} - interval '1 day' AND created_at < ${DAY}) AS y FROM event_log WHERE kind IN ('vehicle_check', 'vehicle_check_repeat') AND detail->>'channel' = 'web'`],
  ['Website visitors', `SELECT count(*) FILTER (WHERE first_seen_at >= ${DAY}) AS t, count(*) FILTER (WHERE first_seen_at >= ${DAY} - interval '1 day' AND first_seen_at < ${DAY}) AS y FROM visitors`],
  ['People active on the website', `SELECT count(DISTINCT coalesce(user_id::text, mobile)) FILTER (WHERE occurred_at >= ${DAY}) AS t, count(DISTINCT coalesce(user_id::text, mobile)) FILTER (WHERE occurred_at >= ${DAY} - interval '1 day' AND occurred_at < ${DAY}) AS y FROM events WHERE channel = 'web' AND coalesce(user_id::text, mobile) IS NOT NULL`],
  ['Payments (paid)', `SELECT count(*) FILTER (WHERE coalesce(paid_at, created_at) >= ${DAY}) AS t, count(*) FILTER (WHERE coalesce(paid_at, created_at) >= ${DAY} - interval '1 day' AND coalesce(paid_at, created_at) < ${DAY}) AS y FROM payments WHERE status = 'paid' AND amount_paise > 0`],
];

(async () => {
  console.log('\nIST day          today   yesterday (whole day)');
  for (const [label, sql] of ROWS) {
    const r = await db.one(sql).catch((e) => ({ t: `error: ${e.message.slice(0, 50)}`, y: '' }));
    console.log(`  ${label.padEnd(32)} ${String(r.t).padStart(5)}   ${String(r.y).padStart(5)}`);
  }
  console.log();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
