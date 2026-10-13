/**
 * src/admin/smsBroadcast.js — SMS BROADCAST (user, 2026-10-13: "select the people and send
 * them the 3-variable DLT promotional SMS, for the 1 DLT template, from the admin panel").
 *
 *   overview()    is the template set up (Settings sms_tpl_promo, its wording
 *                 sms_tpl_promo_text, the promotional header sms_promo_sender_id),
 *                 today's count against sms_promo_per_day, and the recent batches
 *   recipients()  the customers it may go to: agreed in this panel's channel (the
 *                 Customers rule, consented.agreedSql) AND opted in to offers and
 *                 newsletters, not withdrawn — nobody else is even listed
 *   send()        three values, the chosen customers → notify_queue (kind 'promo');
 *                 jobs/reach.js sends a few a minute. Outside 10 am – 9 pm IST the
 *                 batch waits for 10 am. util/sms.js checks the opt-in again per SMS.
 *   cancel()      a batch's SMS not sent yet
 */

const db = require('../db');
const settings = require('../util/settings');

const VAR_MAX = 30;                 // DLT allows about 30 characters per {#var#}
const OPTED = `u.promo_consent_at IS NOT NULL AND u.promo_consent_withdrawn_at IS NULL`;
const istNow = () => new Date(Date.now() + 5.5 * 3600e3);

/** The approved wording with the three values put in. */
const fill = (text, vals) => {
  let i = 0;
  return String(text || '').replace(/\{#var#\}/gi, () => (vals[i++] ?? '…'));
};

/*
 * ONE SMS (user, 2026-10-13: "what I type for all 3 values must fit 160 characters").
 * The whole message, values filled in, must be one SMS: 160 characters in the GSM
 * alphabet, or 70 once any other character is in it (₹, emoji, Hindi — Unicode).
 * Characters from the GSM extension table (^ { } \ [ ] ~ | €) take two places.
 */
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€';
function smsLength(text) {
  const s = String(text || '');
  const unicode = [...s].some((c) => !GSM.includes(c) && !GSM_EXT.includes(c));
  if (unicode) return { unicode: true, length: [...s].length, limit: 70 };
  const length = [...s].reduce((n, c) => n + (GSM_EXT.includes(c) ? 2 : 1), 0);
  return { unicode: false, length, limit: 160 };
}

/** Now if inside 10 am – 9 pm IST, else the next 10 am. */
function nextWindow(at = new Date()) {
  const ist = new Date(at.getTime() + 5.5 * 3600e3);
  const h = ist.getUTCHours();
  if (h >= 10 && h < 21) return at;
  const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + (h >= 21 ? 1 : 0), 10, 0, 0));
  return new Date(day.getTime() - 5.5 * 3600e3);
}

async function template() {
  const id = String(await settings.get('sms_tpl_promo', '') || '').trim();
  const text = String(await settings.get('sms_tpl_promo_text', '') || '').trim();
  const sender = String(await settings.get('sms_promo_sender_id', '') || '').trim() || process.env.FAST2SMS_PROMO_SENDER_ID || '';
  const vars = (text.match(/\{#var#\}/gi) || []).length || 3;
  return { id, text, sender, vars, ready: Boolean(id && text && sender) };
}

async function sentToday() {
  const ist = istNow();
  const startUtc = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 3600e3);
  const r = await db.one(`SELECT count(*)::int AS n FROM notify_queue WHERE channel = 'sms' AND kind = 'promo' AND created_at >= $1
                            AND status <> 'cancelled'`, [startUtc]);
  return r?.n || 0;
}

async function batches() {
  const { rows } = await db.query(
    `SELECT q.note AS batch, min(q.created_at) AS created_at, min(q.send_at) AS send_at, (array_agg(q.vals))[1] AS vals,
            count(*)::int AS total,
            count(*) FILTER (WHERE q.status = 'queued')::int AS queued,
            count(*) FILTER (WHERE q.status = 'sent')::int AS sent,
            count(*) FILTER (WHERE q.status = 'skipped')::int AS skipped,
            count(*) FILTER (WHERE q.status = 'failed')::int AS failed,
            count(*) FILTER (WHERE q.status = 'cancelled')::int AS cancelled,
            (array_agg(a.name))[1] AS admin
       FROM notify_queue q LEFT JOIN admin_users a ON a.id = q.admin_id
      WHERE q.channel = 'sms' AND q.kind = 'promo' AND q.note LIKE 'promo:%'
      GROUP BY q.note ORDER BY min(q.created_at) DESC LIMIT 20`);
  return rows;
}

async function overview() {
  const t = await template();
  const cap = await settings.num('sms_promo_per_day', 500);
  const today = await sentToday();
  const ist = istNow().getUTCHours();
  return { template: t, cap, today, left: Math.max(0, cap - today), in_window: ist >= 10 && ist < 21, batches: await batches() };
}

const FILTERS = {
  all: 'true',
  paid: `EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0)`,
  never_paid: `NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0)`,
  monitoring: `EXISTS (SELECT 1 FROM watches w WHERE w.user_id = u.id AND w.is_active)`,
  not_recent: `NOT EXISTS (SELECT 1 FROM notify_log nl WHERE nl.user_id = u.id AND nl.channel = 'sms' AND nl.kind = 'promo'
                 AND nl.status IN ('sent', 'simulated') AND nl.created_at > now() - interval '7 days')`,
};

/** Opted-in customers (agreed in this panel's channel — or the owner, to test on himself). */
async function recipients({ filter = 'all', q = '', limit = 1000 } = {}) {
  const term = String(q || '').trim();
  const { rows } = await db.query(
    `SELECT u.id, right(regexp_replace(u.mobile, '\\D', '', 'g'), 10) AS mobile,
            coalesce(u.display_name, u.wa_profile_name) AS name, u.last_seen_at, u.promo_consent_at, u.is_internal,
            (SELECT count(*)::int FROM user_vehicles uv WHERE uv.user_id = u.id AND uv.hidden_at IS NULL) AS vehicles,
            EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0) AS paid,
            (SELECT max(nl.created_at) FROM notify_log nl WHERE nl.user_id = u.id AND nl.channel = 'sms' AND nl.kind = 'promo'
                AND nl.status IN ('sent', 'simulated')) AS last_promo_at
       FROM users u
      WHERE u.deactivated_at IS NULL AND u.erased_at IS NULL AND u.mobile IS NOT NULL
        AND ${OPTED}
        AND (${require('./consented').agreedSql('u.mobile')} OR u.is_internal)
        AND (${FILTERS[filter] || 'true'})
        AND ($1 = '' OR u.mobile LIKE '%' || $1 || '%' OR coalesce(u.display_name, u.wa_profile_name, '') ILIKE '%' || $1 || '%')
      ORDER BY u.last_seen_at DESC NULLS LAST
      LIMIT $2`, [term, Math.min(2000, Number(limit) || 1000)]);
  const total = await db.one(
    `SELECT count(*) FILTER (WHERE ${OPTED})::int AS opted, count(*)::int AS agreed
       FROM users u WHERE u.deactivated_at IS NULL AND u.erased_at IS NULL AND u.mobile IS NOT NULL
        AND (${require('./consented').agreedSql('u.mobile')} OR u.is_internal)`);
  return { rows: rows.map((r) => ({ ...r, id: String(r.id) })), opted: total?.opted || 0, agreed: total?.agreed || 0, filters: Object.keys(FILTERS) };
}

/** Queue the batch. { ok, queued, skipped, send_at, batch } or { ok: false, error }. */
async function send({ userIds = [], vals = [], note = '' }, adminId) {
  const t = await template();
  if (!t.id) return { ok: false, error: 'Put the DLT message id of the approved promotional template in Settings (sms_tpl_promo) first.' };
  if (!t.text) return { ok: false, error: 'Paste the approved template wording, with {#var#}, in Settings (sms_tpl_promo_text) first.' };
  if (!t.sender) return { ok: false, error: 'Put your promotional header (6 digits) in Settings (sms_promo_sender_id) first.' };
  const v = (vals || []).slice(0, t.vars).map((x) => String(x ?? '').replace(/\s+/g, ' ').trim());
  if (v.length !== t.vars || v.some((x) => !x)) return { ok: false, error: `The template needs all ${t.vars} values.` };
  const long = v.findIndex((x) => x.length > VAR_MAX);
  if (long >= 0) return { ok: false, error: `Value ${long + 1} is longer than ${VAR_MAX} characters — DLT would cut it.` };
  const size = smsLength(fill(t.text, v));
  if (size.length > size.limit) {
    return { ok: false, error: `The message is ${size.length} characters — one SMS holds ${size.limit}${size.unicode
      ? ' because it has a special character (like ₹, an emoji or Hindi); plain text allows 160' : ''}. Shorten the values.` };
  }
  const ids = [...new Set((userIds || []).map(String).filter((x) => /^\d+$/.test(x)))];
  if (!ids.length) return { ok: false, error: 'Choose at least one customer.' };

  // Only those the list may show — checked again here, never trusted from the browser.
  const allowed = new Set((await recipients({ limit: 2000 })).rows.map((r) => r.id));
  const go = ids.filter((id) => allowed.has(id));
  const cap = await settings.num('sms_promo_per_day', 500);
  const left = Math.max(0, cap - await sentToday());
  if (!left) return { ok: false, error: `Today's limit of ${cap} promotional SMS is used up (Settings sms_promo_per_day).` };
  const take = go.slice(0, left);
  const at = nextWindow();
  const batch = `promo:${new Date().toISOString()}${note ? ` ${String(note).slice(0, 80)}` : ''}`;
  const { rows } = await db.query(
    `INSERT INTO notify_queue (channel, kind, user_id, mobile, vals, send_at, admin_id, note)
     SELECT 'sms', 'promo', u.id, right(regexp_replace(u.mobile, '\\D', '', 'g'), 10), $1::jsonb, $2, $3, $4
       FROM users u WHERE u.id = ANY($5::bigint[])
     RETURNING id`, [JSON.stringify(v), at, adminId || null, batch, take]);
  return { ok: true, queued: rows.length, not_opted: ids.length - go.length, over_cap: go.length - take.length,
           send_at: at, batch, preview: fill(t.text, v) };
}

async function cancel(batch) {
  const { rowCount } = await db.query(
    `UPDATE notify_queue SET status = 'cancelled', result = 'cancelled by an admin'
      WHERE channel = 'sms' AND kind = 'promo' AND note = $1 AND status = 'queued'`, [String(batch || '')]);
  return { ok: true, cancelled: rowCount };
}

module.exports = { overview, recipients, send, cancel, fill, nextWindow, smsLength };
