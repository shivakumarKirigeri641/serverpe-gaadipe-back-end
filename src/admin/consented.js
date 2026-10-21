/**
 * src/admin/consented.js — THE ADMIN PANEL SHOWS ONLY PEOPLE WHO AGREED
 * (user, 2026-10-09, after the 6 Oct "sending spam" disable: "show the customer
 * count only after Agree & continue; do not even show the mobile number if they
 * just said Hi — and filter out those who replied STOP").
 *
 * One filter over every admin API answer, so no screen — old or new — can show
 * them: every customer mobile in the answer is looked up once, and anyone who
 * never agreed to the Terms (WhatsApp "Agree & continue" or the website) or who
 * replied STOP is taken out:
 *   - a row in a list whose own `mobile` is theirs is removed;
 *   - any other place their number appears is blanked (null) and marked hidden.
 * Admins, staff, fleets and referrals are not customers on WhatsApp and are not
 * touched (see SKIP in routes/adminApi.js).
 *
 * The data stays in the database — payments and invoices are legal records — it
 * is only not shown.
 */
const db = require('../db');
const { AsyncLocalStorage } = require('async_hooks');

/*
 * WHICH PANEL IS ASKING (user, 2026-10-09: "give preference to WhatsApp only,
 * hide the web based ones"). The main admin sends X-View: whatsapp and then only
 * an agreement made ON WHATSAPP counts; the web admin also counts the website's.
 * Held for the whole request (routes/adminApi.js), so agreedSql() needs no argument.
 * Agreements recorded before the channel was (all WhatsApp then) count as WhatsApp.
 */
const view = new AsyncLocalStorage();
const whatsappOnlyNow = () => view.getStore()?.whatsappOnly === true;
/*
 * AND THE WEB ADMIN, WEB ONLY (user, 2026-10-10: "hide or disable all WhatsApp
 * content in my web admin panel and only show the web browser visits & users").
 * It sends X-View: web: a person counts once they agreed ON THE WEBSITE (every
 * site sign-in records it, channel 'web'); a WhatsApp STOP does not hide them
 * there, because they chose the website after it.
 */
const webOnlyNow = () => view.getStore()?.webOnly === true;
const channelSql = (alias, whatsappOnly, webOnly = false) => (webOnly
  ? `AND ${alias}.detail->>'channel' = 'web'`
  : whatsappOnly ? `AND coalesce(${alias}.detail->>'channel', 'whatsapp') = 'whatsapp'` : '');
const stopSql = (col, webOnly) => (webOnly ? 'true' : `NOT EXISTS (SELECT 1 FROM whatsapp_sessions so
                   WHERE right(so.mobile, 10) = ${col} AND so.wa_opt_out_at IS NOT NULL)`);

const KEYS = ['mobile', 'phone', 'wa_id', 'customer_mobile', 'checker', 'to'];
const ten = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 && d.length <= 13 ? d.slice(-10) : null;
};

const plain = (v) => v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v);

function collect(node, out, depth = 0) {
  if (!plain(node) || depth > 8) return;
  if (Array.isArray(node)) { for (const x of node) collect(x, out, depth + 1); return; }
  for (const [k, v] of Object.entries(node)) {
    if (KEYS.includes(k)) { const m = ten(v); if (m) out.add(m); }
    else if (plain(v)) collect(v, out, depth + 1);
  }
}

/** Of these mobiles, the ones that may be shown: agreed, never STOP — and staff. */
async function allowedOf(mobiles, { whatsappOnly = whatsappOnlyNow(), webOnly = webOnlyNow() } = {}) {
  if (!mobiles.length) return new Set();
  const { rows } = await db.query(
    `SELECT m FROM unnest($1::text[]) AS m
      WHERE (
              EXISTS (SELECT 1 FROM event_log c WHERE c.kind = 'consent_accepted'
                       AND right(regexp_replace(c.detail->>'mobile', '\\D', '', 'g'), 10) = m
                       ${channelSql('c', whatsappOnly, webOnly)})
              AND ${stopSql('m', webOnly)}
            )
         OR EXISTS (SELECT 1 FROM users u WHERE right(u.mobile, 10) = m AND u.is_internal)
         OR EXISTS (SELECT 1 FROM admin_users a WHERE right(regexp_replace(coalesce(a.mobile, ''), '\\D', '', 'g'), 10) = m)`,
    [mobiles]);
  return new Set(rows.map((r) => r.m));
}

function strip(node, allowed, depth = 0) {
  if (!plain(node) || depth > 8) return node;
  if (Array.isArray(node)) {
    return node
      .filter((x) => !(plain(x) && !Array.isArray(x) && ten(x.mobile) && !allowed.has(ten(x.mobile))))
      .map((x) => strip(x, allowed, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (KEYS.includes(k) && ten(v) && !allowed.has(ten(v))) { out[k] = null; out.hidden = true; }
    else out[k] = plain(v) ? strip(v, allowed, depth + 1) : v;
  }
  return out;
}

/** The answer with everyone who did not agree, or said STOP, taken out. */
async function filter(body, { whatsappOnly = whatsappOnlyNow(), webOnly = webOnlyNow() } = {}) {
  const found = new Set();
  collect(body, found);
  if (!found.size) return body;
  const allowed = await allowedOf([...found], { whatsappOnly, webOnly });
  if (allowed.size === found.size) return body;
  return strip(body, allowed);
}

/*
 * NEVER MY OWN ROWS (user, 2026-10-21: "for any visits, sign-ins or more, do not include my details").
 * After the agreed-only filter, every list row that is the owner's own — by mobile, by account
 * (user_id), by browser (visitor_id) or by device (device_id) — is taken out, in every admin answer.
 * "Mine" is admin/notMe.js's rule: users.is_internal (internal_mobiles / "This is me"), the admins'
 * own numbers, and any browser or device an internal person has signed in on. admin_hide_me = false
 * shows them again.
 */
const ME_KEYS = { mobile: KEYS, user: ['user_id', 'customer_id'], visitor: ['visitor_id'], device: ['device_id'] };
function collectMe(node, out, depth = 0) {
  if (!plain(node) || depth > 8) return;
  if (Array.isArray(node)) { for (const x of node) collectMe(x, out, depth + 1); return; }
  for (const [k, v] of Object.entries(node)) {
    if (v == null) continue;
    if (ME_KEYS.mobile.includes(k)) { const m = ten(v); if (m) out.mobile.add(m); }
    else if (ME_KEYS.user.includes(k) && /^\d+$/.test(String(v))) out.user.add(String(v));
    else if (ME_KEYS.visitor.includes(k) && typeof v !== 'object') out.visitor.add(String(v));
    else if (ME_KEYS.device.includes(k) && typeof v !== 'object') out.device.add(String(v));
    else if (plain(v)) collectMe(v, out, depth + 1);
  }
}
async function hideMe(body) {
  if (!(await require('../util/settings').bool('admin_hide_me', true))) return body;
  const found = { mobile: new Set(), user: new Set(), visitor: new Set(), device: new Set() };
  collectMe(body, found);
  if (!found.mobile.size && !found.user.size && !found.visitor.size && !found.device.size) return body;
  const { rows: [me] } = await db.query(
    `SELECT
       ARRAY(SELECT m FROM unnest($1::text[]) m WHERE EXISTS (SELECT 1 FROM users u WHERE u.is_internal AND right(u.mobile, 10) = m)
                OR EXISTS (SELECT 1 FROM admin_users a WHERE right(regexp_replace(coalesce(a.mobile, ''), '\\D', '', 'g'), 10) = m)) AS mobile,
       ARRAY(SELECT x FROM unnest($2::text[]) x WHERE EXISTS (SELECT 1 FROM users u WHERE u.is_internal AND u.id::text = x)) AS user,
       ARRAY(SELECT x FROM unnest($3::text[]) x WHERE EXISTS (SELECT 1 FROM visitors iv JOIN users iu ON (iu.id = iv.user_id OR iu.mobile = iv.mobile)
                                                              WHERE iu.is_internal AND iv.visitor_id::text = x)) AS visitor,
       ARRAY(SELECT x FROM unnest($4::text[]) x WHERE EXISTS (SELECT 1 FROM site_sign_ins s JOIN users u ON u.id = s.user_id
                                                              WHERE u.is_internal AND s.device_id::text = x)) AS device`,
    [[...found.mobile], [...found.user], [...found.visitor], [...found.device]]);
  const mine = { mobile: new Set(me.mobile), user: new Set(me.user), visitor: new Set(me.visitor), device: new Set(me.device) };
  if (!mine.mobile.size && !mine.user.size && !mine.visitor.size && !mine.device.size) return body;
  const isMine = (x) => Object.entries(x).some(([k, v]) => v != null && (
    (ME_KEYS.mobile.includes(k) && mine.mobile.has(ten(v)))
    || (ME_KEYS.user.includes(k) && mine.user.has(String(v)))
    || (ME_KEYS.visitor.includes(k) && mine.visitor.has(String(v)))
    || (ME_KEYS.device.includes(k) && mine.device.has(String(v)))));
  const drop = (node, depth = 0) => {
    if (!plain(node) || depth > 8) return node;
    if (Array.isArray(node)) return node.filter((x) => !(plain(x) && !Array.isArray(x) && isMine(x))).map((x) => drop(x, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = plain(v) ? drop(v, depth + 1) : v;
    return out;
  };
  return drop(body);
}

/*
 * The same rule as an SQL condition over a mobile column, for the lists and
 * counts that must not even count them (Customers, Live conversations).
 */
const agreedSql = (col, { whatsappOnly = whatsappOnlyNow(), webOnly = webOnlyNow() } = {}) => `(
  EXISTS (SELECT 1 FROM event_log ac WHERE ac.kind = 'consent_accepted'
           AND right(regexp_replace(ac.detail->>'mobile', '\\D', '', 'g'), 10) = right(${col}, 10)
           ${channelSql('ac', whatsappOnly, webOnly)})
  AND ${stopSql(`right(${col}, 10)`, webOnly)})`;

/*
 * THE PANEL'S CHANNEL FOR ANY NUMBER (user, 2026-10-16: "check the entire WhatsApp admin panel's
 * APIs — make sure all are WhatsApp and sync properly"). One rule for every count and chart, so
 * no screen keeps its own copy: in the main admin (X-View: whatsapp) a WhatsApp row, in the web
 * admin a website row, with no view everything. Each returns an SQL condition (never empty).
 *   pay(p)     a payment — by the channel it was bought in (raw.channel; migration 191 set it for
 *              every WhatsApp purchase; paid_from is only the browser it was paid in)
 *   check(e)   a vehicle check in event_log (a WhatsApp check is saved without a channel)
 *   report(r)  a vehicle report (its own channel column)
 *   sub(s)     a subscription, by the channel of the payment that bought it
 *   user(u)    a person: agreed in this channel (the Customers rule)
 */
function chan() {
  const wa = whatsappOnlyNow(); const web = webOnlyNow();
  const PAY = (p) => `coalesce(nullif(${p}.raw->>'channel', ''), 'whatsapp')`;
  const payIs = (p) => (wa ? `${PAY(p)} NOT IN ('web', 'website')` : web ? `${PAY(p)} IN ('web', 'website')` : 'true');
  return {
    wa, web,
    pay: payIs,
    check: (e) => (wa ? `coalesce(${e}.detail->>'channel', 'whatsapp') = 'whatsapp'` : web ? `${e}.detail->>'channel' = 'web'` : 'true'),
    report: (r) => (wa ? `coalesce(${r}.channel, 'whatsapp') <> 'web'` : web ? `${r}.channel = 'web'` : 'true'),
    // A row of the `events` stream (its own channel column: whatsapp, web or system).
    event: (e) => (wa ? `coalesce(${e}.channel, '') <> 'web'` : web ? `${e}.channel = 'web'` : 'true'),
    sub: (s) => (wa || web ? `EXISTS (SELECT 1 FROM payments sp WHERE sp.subscription_id = ${s}.id AND sp.status = 'paid' AND ${payIs('sp')})` : 'true'),
    user: (u) => (wa || web ? agreedSql(`${u}.mobile`) : 'true'),
  };
}

/*
 * ONE STORY, EVERY CHANNEL (user, 2026-10-21: "count from the WhatsApp numbers till yesterday, and going
 * on, the web"). In the web admin with admin_web_shows_all on, the counts that are about customers,
 * checks, reports, payments and money take every channel — WhatsApp's history and the website's from now
 * on. Counts that only the website has (visitors, visits, pages) stay the website's.
 */
const allChannelsNow = () => view.getStore()?.allChannels === true;

module.exports = { filter, hideMe, allowedOf, agreedSql, view, webOnlyNow, whatsappOnlyNow, allChannelsNow, chan };
