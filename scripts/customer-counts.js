/**
 * scripts/customer-counts.js — HOW MANY CUSTOMERS (user, 2026-10-15: "a script to show total
 * customers and total agreed customers"). Read-only: counts, no numbers printed.
 *
 *   node scripts/customer-counts.js
 *   node scripts/customer-counts.js --since 2026-10-15     also: day by day from that date (IST) to today
 *
 * --since (user, 2026-10-15: "after coming back, give me a command for the customer count from
 * today, how many paid"): each day's new chats, agreed, checked a vehicle, opened a payment, paid,
 * and the money — then the totals and how many of the new chats paid.
 *
 * Your own (internal) numbers are left out of every line.
 */
require('dotenv').config();
const db = require('../src/db');

const AGREED = (channel) => `
  SELECT DISTINCT right(regexp_replace(c.detail->>'mobile', '\\D', '', 'g'), 10) AS m FROM event_log c
   WHERE c.kind = 'consent_accepted' ${channel === 'whatsapp' ? `AND coalesce(c.detail->>'channel', 'whatsapp') = 'whatsapp'`
     : channel === 'web' ? `AND c.detail->>'channel' = 'web'` : ''}`;
const NOT_ME = (col) => `NOT EXISTS (SELECT 1 FROM users i WHERE right(i.mobile, 10) = ${col} AND i.is_internal)`;
const STOPPED = (col) => `EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE right(s.mobile, 10) = ${col} AND s.wa_opt_out_at IS NOT NULL)`;
const TODAY = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

(async () => {
  const n = async (sql) => Number((await db.one(sql))?.n || 0);
  const out = {
    'Everyone who ever wrote or signed in (users)': await n(`SELECT count(*) AS n FROM users u WHERE NOT coalesce(u.is_internal, false)`),
    'Said Hi on WhatsApp (chats)': await n(`SELECT count(*) AS n FROM whatsapp_sessions s WHERE ${NOT_ME('right(s.mobile, 10)')}`),
    'Agreed — WhatsApp': await n(`SELECT count(*) AS n FROM (${AGREED('whatsapp')}) a WHERE ${NOT_ME('a.m')}`),
    'Agreed — website (signed in)': await n(`SELECT count(*) AS n FROM (${AGREED('web')}) a WHERE ${NOT_ME('a.m')}`),
    'Agreed — anywhere (each person once)': await n(`SELECT count(*) AS n FROM (${AGREED('all')}) a WHERE ${NOT_ME('a.m')}`),
    '  of them sent STOP': await n(`SELECT count(*) AS n FROM (${AGREED('all')}) a WHERE ${NOT_ME('a.m')} AND ${STOPPED('a.m')}`),
    '  reachable now (agreed, no STOP, account open)': await n(`SELECT count(*) AS n FROM (${AGREED('all')}) a WHERE ${NOT_ME('a.m')} AND NOT ${STOPPED('a.m')}
        AND NOT EXISTS (SELECT 1 FROM users u WHERE right(u.mobile, 10) = a.m AND u.deactivated_at IS NOT NULL)`),
    '  opted in to offers': await n(`SELECT count(*) AS n FROM users u WHERE u.promo_consent_at IS NOT NULL AND NOT coalesce(u.is_internal, false)`),
    '  with a confirmed email': await n(`SELECT count(*) AS n FROM users u WHERE u.email_verified_at IS NOT NULL AND NOT coalesce(u.is_internal, false)`),
    'Paying customers (real payments, not test)': await n(`SELECT count(DISTINCT p.user_id) AS n FROM payments p JOIN users u ON u.id = p.user_id
        WHERE p.status = 'paid' AND p.amount_paise > 0 AND (p.raw->>'test_mode') IS NULL AND NOT coalesce(u.is_internal, false)`),
    'Paid reports (real)': await n(`SELECT count(*) AS n FROM payments p JOIN users u ON u.id = p.user_id
        WHERE p.status = 'paid' AND p.amount_paise > 0 AND (p.raw->>'test_mode') IS NULL AND NOT coalesce(u.is_internal, false)`),
    'Today — new WhatsApp chats': await n(`SELECT count(*) AS n FROM whatsapp_sessions s WHERE s.created_at >= ${TODAY} AND ${NOT_ME('right(s.mobile, 10)')}`),
    'Today — agreed': await n(`SELECT count(DISTINCT right(regexp_replace(c.detail->>'mobile', '\\D', '', 'g'), 10)) AS n FROM event_log c
        WHERE c.kind = 'consent_accepted' AND c.created_at >= ${TODAY} AND ${NOT_ME(`right(regexp_replace(c.detail->>'mobile', '\\D', '', 'g'), 10)`)}`),
  };
  const w = Math.max(...Object.keys(out).map((k) => k.length));
  for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(w)}  ${String(v).padStart(5)}`);

  /* DAY BY DAY SINCE A DATE (2026-10-15). Each day in IST; people counted once per column per day. */
  const i = process.argv.indexOf('--since');
  const since = i > 0 ? String(process.argv[i + 1] || '') : '';
  if (since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) { console.log('\n--since needs a date like 2026-10-15'); process.exit(1); }
    const REAL = `p.status = 'paid' AND p.amount_paise > 0 AND (p.raw->>'test_mode') IS NULL`;
    const { rows } = await db.query(
      `WITH d AS (SELECT generate_series($1::date, (now() AT TIME ZONE 'Asia/Kolkata')::date, '1 day')::date AS day),
            ist AS (SELECT day, (day::timestamp AT TIME ZONE 'Asia/Kolkata') AS a, ((day + 1)::timestamp AT TIME ZONE 'Asia/Kolkata') AS b FROM d)
       SELECT to_char(ist.day, 'Dy DD Mon') AS day,
         (SELECT count(*) FROM whatsapp_sessions s WHERE s.created_at >= ist.a AND s.created_at < ist.b
             AND ${NOT_ME('right(s.mobile, 10)')})::int AS chats,
         (SELECT count(DISTINCT right(regexp_replace(c.detail->>'mobile', '\\D', '', 'g'), 10)) FROM event_log c
           WHERE c.kind = 'consent_accepted' AND c.created_at >= ist.a AND c.created_at < ist.b
             AND ${NOT_ME(`right(regexp_replace(c.detail->>'mobile', '\\D', '', 'g'), 10)`)})::int AS agreed,
         (SELECT count(DISTINCT e.user_id) FROM event_log e WHERE e.kind IN ('vehicle_check', 'vehicle_check_repeat')
             AND e.created_at >= ist.a AND e.created_at < ist.b
             AND e.user_id NOT IN (SELECT id FROM users WHERE is_internal))::int AS checked,
         (SELECT count(DISTINCT p.user_id) FROM payments p JOIN users u ON u.id = p.user_id
           WHERE p.created_at >= ist.a AND p.created_at < ist.b AND p.amount_paise > 0
             AND (p.raw->>'test_mode') IS NULL AND NOT coalesce(u.is_internal, false))::int AS opened_pay,
         (SELECT count(DISTINCT p.user_id) FROM payments p JOIN users u ON u.id = p.user_id
           WHERE ${REAL} AND p.paid_at >= ist.a AND p.paid_at < ist.b AND NOT coalesce(u.is_internal, false))::int AS paid,
         (SELECT coalesce(sum(p.amount_paise), 0) FROM payments p JOIN users u ON u.id = p.user_id
           WHERE ${REAL} AND p.paid_at >= ist.a AND p.paid_at < ist.b AND NOT coalesce(u.is_internal, false))::bigint AS paise
       FROM ist ORDER BY ist.day`, [since]);
    const head = ['Day', 'New chats', 'Agreed', 'Checked', 'Opened pay', 'Paid', 'Revenue'];
    const line = (c) => `${String(c[0]).padEnd(12)}${c.slice(1).map((x) => String(x).padStart(11)).join('')}`;
    console.log(`\nSince ${since} (IST), people per day:`);
    console.log(line(head));
    const sum = { chats: 0, agreed: 0, checked: 0, opened_pay: 0, paid: 0, paise: 0 };
    for (const r of rows) {
      for (const k of Object.keys(sum)) sum[k] += Number(r[k]);
      console.log(line([r.day, r.chats, r.agreed, r.checked, r.opened_pay, r.paid, `Rs.${(Number(r.paise) / 100).toFixed(0)}`]));
    }
    console.log(line(['Total', sum.chats, sum.agreed, sum.checked, sum.opened_pay, sum.paid, `Rs.${(sum.paise / 100).toFixed(0)}`]));
    const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');
    console.log(`\nOf the new chats: ${pct(sum.agreed, sum.chats)} agreed · ${pct(sum.paid, sum.chats)} paid.`
      + ` Of those who opened a payment: ${pct(sum.paid, sum.opened_pay)} paid.`);
    console.log('(Checked and Paid count anyone that day, new or old customer; a person paying on two days counts on each.)');
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
