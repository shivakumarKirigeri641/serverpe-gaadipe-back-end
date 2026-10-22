/**
 * scripts/signin-funnel.js — WHERE VISITORS STOP BEFORE SIGNING IN (user, 2026-10-22: "yesterday's visit
 * count, sign-in count, and today's — many visitors but sign-ins are less"). Read-only. Each step of the
 * website funnel, by IST day: today so far, yesterday up to this same time, and the whole of yesterday.
 * The owner's own visits, checks and sign-ins are left out (src/admin/notMe.js).
 *
 *   node scripts/signin-funnel.js
 *   node scripts/signin-funnel.js --days 7     one line per day for the last 7 days instead
 */
require('dotenv').config();
const db = require('../src/db');
const notMe = require('../src/admin/notMe');

const DAY = `date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`;
// Every step counts PEOPLE (a browser / a mobile), not rows, between $1 and $2.
const WEB = `channel = 'web' AND occurred_at >= $1 AND occurred_at < $2 AND ${notMe.evt('e')}`;
const ANON = `created_at >= $1 AND created_at < $2 AND ${notMe.visitor('a.visitor_id')} AND ${notMe.device('a.device_id')}`;
const SIGN = `created_at >= $1 AND created_at < $2 AND ${notMe.mobile('s.mobile')} AND ${notMe.user('s.user_id')}`;
const WHO = `coalesce(a.visitor_id, a.device_id)`;

const STEPS = [
  ['1 Visitors on the site', `SELECT count(DISTINCT e.visitor_id) FROM events e WHERE ${WEB}`],
  ['   new to the site that day', `SELECT count(*) FROM visitors v WHERE v.first_seen_at >= $1 AND v.first_seen_at < $2 AND ${notMe.visitor('v.visitor_id')}`],
  ['   saw only one page', `SELECT count(*) FROM (SELECT e.visitor_id FROM events e WHERE ${WEB} AND e.name = 'page_view' GROUP BY 1 HAVING count(*) = 1) x`],
  ['2 Opened the chat or app', `SELECT count(DISTINCT e.visitor_id) FROM events e WHERE ${WEB} AND e.name = 'page_view' AND (e.page LIKE '/chat%' OR e.page LIKE '/go%')`],
  ['3 Typed a vehicle number', `SELECT count(DISTINCT ${WHO}) FROM anon_checks a WHERE ${ANON}`],
  ['   stopped at "Agree & check"', `SELECT count(DISTINCT ${WHO}) FROM anon_checks a WHERE ${ANON} AND a.refusal = 'no_consent' AND ${WHO} NOT IN (SELECT ${WHO} FROM anon_checks a WHERE ${ANON} AND a.refusal IS DISTINCT FROM 'no_consent' AND ${WHO} IS NOT NULL)`],
  ['4 Got a free answer', `SELECT count(DISTINCT ${WHO}) FROM anon_checks a WHERE ${ANON} AND a.outcome IN ('shown', 'not_found')`],
  ['   lookup failed (no answer)', `SELECT count(DISTINCT ${WHO}) FROM anon_checks a WHERE ${ANON} AND a.outcome = 'failed'`],
  ['5 Asked to sign in (free limit)', `SELECT count(DISTINCT ${WHO}) FROM anon_checks a WHERE ${ANON} AND a.refusal IN ('daily_limit_device', 'daily_limit_ip', 'no_device_id')`],
  ['6 Asked for a sign-in code', `SELECT count(DISTINCT right(s.mobile, 10)) FROM site_sign_ins s WHERE ${SIGN} AND s.event = 'code_requested'`],
  ['   typed a wrong code', `SELECT count(DISTINCT right(s.mobile, 10)) FROM site_sign_ins s WHERE ${SIGN} AND s.event = 'sign_in_failed'`],
  ['   code asked, never signed in', `SELECT count(DISTINCT right(s.mobile, 10)) FROM site_sign_ins s WHERE ${SIGN} AND s.event = 'code_requested'
      AND right(s.mobile, 10) NOT IN (SELECT right(s.mobile, 10) FROM site_sign_ins s WHERE ${SIGN} AND s.event = 'signed_in' AND s.mobile IS NOT NULL)`],
  ['7 Signed in', `SELECT count(DISTINCT coalesce(s.user_id::text, right(s.mobile, 10))) FROM site_sign_ins s WHERE ${SIGN} AND s.event = 'signed_in'`],
  ['   brand-new accounts', `SELECT count(*) FROM users u WHERE u.created_at >= $1 AND u.created_at < $2 AND u.signup_channel = 'web' AND NOT coalesce(u.is_internal, false)`],
  ['8 Paid', `SELECT count(DISTINCT p.user_id) FROM payments p WHERE p.status = 'paid' AND p.amount_paise > 0
      AND coalesce(p.paid_at, p.created_at) >= $1 AND coalesce(p.paid_at, p.created_at) < $2 AND ${notMe.pay('p')}`],
];

const count = (sql, from, to) => db.one(`SELECT (${sql}) AS n`, [from, to]).then((r) => Number(r.n)).catch((e) => `err: ${e.message.slice(0, 40)}`);
const pct = (n, of) => (typeof n === 'number' && of > 0 ? `${Math.round((n / of) * 100)}%` : '');

async function threeWindows() {
  const w = await db.one(`SELECT ${DAY} AS t0, now() AS now, ${DAY} - interval '1 day' AS y0, now() - interval '1 day' AS ynow`);
  const cols = [['today so far', w.t0, w.now], ['yday same time', w.y0, w.ynow], ['yesterday', w.y0, w.t0]];
  const res = [];
  for (const [, a, b] of cols) {
    const col = [];
    for (const [, sql] of STEPS) col.push(await count(sql, a, b));
    res.push(col);
  }
  console.log(`\nSIGN-IN FUNNEL (IST, your own visits left out)   ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n`);
  console.log(`  ${''.padEnd(34)}${cols.map(([h]) => h.padStart(16)).join('')}`);
  STEPS.forEach(([label], i) => {
    const cells = res.map((col) => {
      const n = col[i];
      const share = label[0] !== ' ' && i > 0 ? pct(n, col[0]) : '';
      return `${n}${share ? ` (${share})` : ''}`.padStart(16);
    });
    console.log(`  ${label.padEnd(34)}${cells.join('')}`);
  });
  console.log('\n  (%) = share of that day\'s visitors.');
}

async function perDay(days) {
  const heads = ['Visitors', 'Chat', 'Checked', 'Limit', 'Code', 'Signed in', 'Paid'];
  const pick = [0, 3, 4, 8, 9, 12, 14];
  console.log(`\nLAST ${days} DAYS (IST, your own visits left out)\n`);
  console.log(`  ${'day'.padEnd(12)}${heads.map((h) => h.padStart(10)).join('')}`);
  for (let d = days - 1; d >= 0; d--) {
    const w = await db.one(`SELECT ${DAY} - make_interval(days => $1::int) AS a, ${DAY} - make_interval(days => $1::int - 1) AS b,
      to_char((${DAY} - make_interval(days => $1::int)) AT TIME ZONE 'Asia/Kolkata', 'DD Mon Dy') AS label`, [d]);
    const cells = [];
    for (const i of pick) cells.push(String(await count(STEPS[i][1], w.a, w.b)).padStart(10));
    console.log(`  ${w.label.padEnd(12)}${cells.join('')}${d === 0 ? '   (so far)' : ''}`);
  }
}

(async () => {
  const i = process.argv.indexOf('--days');
  if (i > 0) await perDay(Math.max(1, Math.min(31, Number(process.argv[i + 1]) || 7)));
  else await threeWindows();
  console.log();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
