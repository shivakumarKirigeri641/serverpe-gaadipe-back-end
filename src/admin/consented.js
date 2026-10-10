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
 * The same rule as an SQL condition over a mobile column, for the lists and
 * counts that must not even count them (Customers, Live conversations).
 */
const agreedSql = (col, { whatsappOnly = whatsappOnlyNow(), webOnly = webOnlyNow() } = {}) => `(
  EXISTS (SELECT 1 FROM event_log ac WHERE ac.kind = 'consent_accepted'
           AND right(regexp_replace(ac.detail->>'mobile', '\\D', '', 'g'), 10) = right(${col}, 10)
           ${channelSql('ac', whatsappOnly, webOnly)})
  AND ${stopSql(`right(${col}, 10)`, webOnly)})`;

module.exports = { filter, allowedOf, agreedSql, view, webOnlyNow, whatsappOnlyNow };
