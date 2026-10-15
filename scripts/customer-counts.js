/**
 * scripts/customer-counts.js — HOW MANY CUSTOMERS (user, 2026-10-15: "a script to show total
 * customers and total agreed customers"). Read-only: counts, no numbers printed.
 *
 *   node scripts/customer-counts.js
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
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
