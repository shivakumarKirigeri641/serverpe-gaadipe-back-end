/**
 * scripts/funnel.js — where customers stop, in counts (user, 2026-09-22).
 *
 *   node scripts/funnel.js        the last 30 days
 *   node scripts/funnel.js 7      the last 7 days
 *
 * Counts CUSTOMERS, not clicks, at each step: signed in, checked a vehicle,
 * opened Buy, tapped Pay, reached checkout, paid. Also what the ones who did
 * not pay touched last. Writes gp-funnel.json beside it — counts only, no
 * personal data, so it is safe to send to someone outside the business.
 */

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const days = Math.max(1, Math.min(365, Number(process.argv[2]) || 30));
const SINCE = `now() - interval '${days} days'`;
const IST = `AT TIME ZONE 'Asia/Kolkata'`;
const PAGE = `regexp_replace(split_part(page, '?', 1), '/(vehicle|reports|invoices|q)/[^/]+', '/\\1/*')`;
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const L = (s, n) => String(s).padEnd(n);
const R = (s, n) => String(s).padStart(n);

(async () => {
  const c = new Client(); await c.connect();
  const one = async (sql) => (await c.query(sql)).rows[0];
  const many = async (sql) => (await c.query(sql)).rows;
  const has = async (t) => (await one(`SELECT to_regclass('public.${t}') IS NOT NULL AS ok`)).ok;
  const clicksTracked = await has('site_activity');

  const f = await one(`
    WITH a AS (SELECT user_id, kind, action, detail FROM site_activity WHERE created_at > ${SINCE})
    SELECT (SELECT count(DISTINCT user_id) FROM a) signed_in,
           (SELECT count(DISTINCT user_id) FROM a WHERE action IN ('check','check_paid')) checked,
           (SELECT count(DISTINCT user_id) FROM a WHERE action = 'buy_open') opened_buy,
           (SELECT count(DISTINCT user_id) FROM a WHERE kind='click' AND detail->>'label' ILIKE 'pay now%') tapped_pay,
           (SELECT count(DISTINCT user_id) FROM a WHERE action = 'pay_start') checkout,
           (SELECT count(DISTINCT user_id) FROM payments WHERE status='paid' AND gateway <> 'free' AND paid_at > ${SINCE}) paid,
           (SELECT count(*) FROM payments WHERE status='paid' AND gateway <> 'free' AND paid_at > ${SINCE}) payments,
           (SELECT coalesce(sum(amount_paise),0) FROM payments WHERE status='paid' AND gateway <> 'free' AND paid_at > ${SINCE}) paise`);

  const steps = [['Signed in, did something', +f.signed_in], ['Checked a vehicle', +f.checked],
    ['Opened the Buy dialog', +f.opened_buy], ['Tapped "Pay now"', +f.tapped_pay],
    ['Reached the checkout page', +f.checkout], ['PAID', +f.paid]];
  console.log(`\nGaadiPe — last ${days} days (customers, not clicks)\n`);
  let prev = null;
  for (const [label, n] of steps) {
    console.log(`  ${L(label, 27)} ${R(n, 5)}  ${R(pct(n, steps[0][1]), 5)} of all` +
      (prev === null ? '' : `   lost ${R(prev - n, 4)} (${pct(prev - n, prev)})`));
    prev = n;
  }
  console.log(`\n  Payments: ${f.payments} · ₹${(+f.paise / 100).toFixed(2)}`);

  const drop = await many(`
    WITH openers AS (SELECT DISTINCT user_id FROM site_activity WHERE created_at > ${SINCE} AND action='buy_open'),
         payers AS (SELECT DISTINCT user_id FROM payments WHERE status='paid' AND paid_at > ${SINCE})
    SELECT a.kind, coalesce(a.detail->>'label', a.action) what, count(DISTINCT a.user_id)::int customers
      FROM site_activity a JOIN openers o ON o.user_id = a.user_id
     WHERE a.created_at > ${SINCE} AND a.user_id NOT IN (SELECT user_id FROM payers)
       AND (a.kind='click' OR a.action IN ('buy_open','buy_close','pay_start'))
     GROUP BY 1,2 ORDER BY customers DESC LIMIT 20`);
  if (drop.length) {
    console.log('\n  Opened Buy but did NOT pay — what they touched:');
    drop.forEach((r) => console.log(`   ${R(r.customers, 4)}  ${L(r.kind, 7)} ${r.what}`));
  }

  const pages = await many(`SELECT ${PAGE} page, count(*)::int views, count(DISTINCT user_id)::int customers
      FROM site_activity WHERE created_at > ${SINCE} AND kind='page' GROUP BY 1 ORDER BY views DESC LIMIT 15`);
  console.log('\n  Most opened pages:');
  pages.forEach((r) => console.log(`   ${R(r.customers, 4)} customers  ${R(r.views, 5)} views  ${r.page}`));

  const src = await many(`SELECT CASE WHEN page ILIKE '%gad_source%' OR page ILIKE '%gclid%' OR page ILIKE '%gbraid%' THEN 'google_ads'
        WHEN page ILIKE '%utm_source=%' THEN split_part(split_part(page,'utm_source=',2),'&',1) ELSE 'direct_or_other' END source,
        count(DISTINCT user_id)::int customers FROM site_activity
       WHERE created_at > ${SINCE} AND kind='page' GROUP BY 1 ORDER BY customers DESC`);
  console.log('\n  Arrived from:');
  src.forEach((r) => console.log(`   ${R(r.customers, 4)}  ${r.source}`));

  const daily = await many(`
    WITH d AS (SELECT generate_series((${SINCE})::date, now()::date, '1 day')::date AS dt)
    SELECT d.dt::text date,
      (SELECT count(DISTINCT user_id)::int FROM site_activity a WHERE (a.created_at ${IST})::date = d.dt AND a.action IN ('check','check_paid')) checked,
      (SELECT count(DISTINCT user_id)::int FROM site_activity a WHERE (a.created_at ${IST})::date = d.dt AND a.action='buy_open') opened_buy,
      (SELECT count(DISTINCT user_id)::int FROM site_activity a WHERE (a.created_at ${IST})::date = d.dt AND a.action='pay_start') checkout,
      (SELECT count(*)::int FROM payments p WHERE p.status='paid' AND p.gateway <> 'free' AND (p.paid_at ${IST})::date = d.dt) paid,
      (SELECT count(DISTINCT user_id)::int FROM site_sign_ins s WHERE s.event='signed_in' AND (s.created_at ${IST})::date = d.dt) sign_ins
      FROM d ORDER BY d.dt`);
  console.log('\n  By day (IST):  date        sign-ins  checked  buy  checkout  paid');
  daily.forEach((r) => console.log(`                 ${r.date}  ${R(r.sign_ins, 8)}  ${R(r.checked, 7)}  ${R(r.opened_buy, 3)}  ${R(r.checkout, 8)}  ${R(r.paid, 4)}`));

  const totals = await one(`SELECT
      (SELECT count(*)::int FROM users) customers,
      (SELECT count(*)::int FROM users WHERE created_at > ${SINCE}) new_customers,
      (SELECT count(*)::int FROM users WHERE email_verified_at IS NOT NULL) email_confirmed,
      (SELECT count(*)::int FROM users WHERE quizpe_consent_at IS NOT NULL) quizpe_consent,
      (SELECT count(*)::int FROM vehicle_reports WHERE created_at > ${SINCE}) reports_issued,
      (SELECT count(*)::int FROM api_calls WHERE created_at > ${SINCE} AND NOT ok) lookup_failures`);
  console.log(`\n  Customers ${totals.customers} (new ${totals.new_customers}) · email confirmed ${totals.email_confirmed}`
    + ` · QuizPe consent ${totals.quizpe_consent} · reports ${totals.reports_issued} · failed lookups ${totals.lookup_failures}`);
  if (!clicksTracked) console.log('\n  (site_activity is missing — deploy the click tracking first.)');

  const out = { generated_at: new Date().toISOString(), window_days: days, contains_personal_data: false,
    funnel: steps.map(([step, customers]) => ({ step, customers })), payments: +f.payments, revenue_paise: +f.paise,
    dropoff_of_non_payers: drop, top_pages: pages, sources: src, daily, totals };
  fs.writeFileSync('gp-funnel.json', JSON.stringify(out, null, 2));
  console.log('\n  Saved: gp-funnel.json  (counts only — safe to share)\n');
  await c.end(); process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
