/**
 * src/admin/smsBroadcast.js — SMS BROADCAST from the admin panel, two modes:
 *
 *   promo    (user, 2026-10-13: "select the people and send them the 3-variable DLT
 *            promotional SMS") — Settings sms_tpl_promo / sms_tpl_promo_text, sent from
 *            the promotional header sms_promo_sender_id, ONLY to customers who agreed
 *            AND opted in to offers and newsletters (util/sms.js checks it again).
 *   service  (user, 2026-10-13: "broadcast all 158 that we are on WhatsApp now — at
 *            least that I have to send to all") — a DLT "Service Implicit" template
 *            (sms_tpl_service / sms_tpl_service_text), a factual update about the
 *            service, no offer: to EVERY customer who agreed in this panel's channel,
 *            from the usual (transactional) header. Its variables may be 0 to 3.
 *
 * The templates themselves live in sms_templates (migration 187, 2026-10-15) — chosen from a list,
 * each with its kind, DLT message id, wording and header — no longer typed into Settings.
 *
 *   overview()    the chosen template, all templates, today's count against sms_promo_per_day, batches
 *   recipients()  who the mode may reach (consented.agreedSql — the Customers rule)
 *   send()        values + chosen customers → notify_queue; jobs/reach.js sends a few a
 *                 minute, only 10 am – 9 pm IST (a batch outside waits for 10 am)
 *   cancel()      a batch's SMS not sent yet
 * The whole message, values filled in, must be ONE SMS (smsLength).
 */

const db = require('../db');
const settings = require('../util/settings');

const VAR_MAX = 30;                 // DLT allows about 30 characters per {#var#}
const OPTED = `u.promo_consent_at IS NOT NULL AND u.promo_consent_withdrawn_at IS NULL`;
const MODES = ['promo', 'service'];
const modeOf = (m) => (MODES.includes(m) ? m : 'promo');
const istNow = () => new Date(Date.now() + 5.5 * 3600e3);

/** The approved wording with the values put in. */
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

/*
 * THE TEMPLATES (user, 2026-10-15: "one selectable SMS template, and typing 1, 2 or 3 parameters
 * based on which template I select"; migration 187). Each approved DLT template is kept once in
 * sms_templates; the broadcast picks one, and its kind decides who may receive it.
 */
const varsOf = (body) => (String(body || '').match(/\{#var#\}/gi) || []).length;

/** The header a template goes from: its own, else the promotional / usual one. */
async function senderOf(row) {
  if (row.sender) return row.sender;
  return row.kind === 'promo'
    ? String(await settings.get('sms_promo_sender_id', '') || '').trim() || process.env.FAST2SMS_PROMO_SENDER_ID || ''
    : process.env.FAST2SMS_SENDER_ID || '';
}

const shape = async (r) => ({
  key: String(r.id), name: r.name, mode: r.kind, id: r.dlt_id, text: r.body, own_sender: r.sender || null,
  sender: await senderOf(r), vars: varsOf(r.body), active: r.is_active, modified_at: r.modified_at,
  ready: Boolean(r.dlt_id && r.body && await senderOf(r)),
});

async function templates({ all = false } = {}) {
  const { rows } = await db.query(`SELECT * FROM sms_templates ${all ? '' : 'WHERE is_active'} ORDER BY kind DESC, name, id`);
  return Promise.all(rows.map(shape));
}

/** One template by its key, or the first active one — null when there is none. */
async function template(key) {
  const r = /^\d+$/.test(String(key || ''))
    ? await db.one(`SELECT * FROM sms_templates WHERE id = $1 AND is_active`, [Number(key)])
    : await db.one(`SELECT * FROM sms_templates WHERE is_active ORDER BY kind DESC, name, id LIMIT 1`);
  return r ? shape(r) : null;
}

/** Add or change a template. { ok, template } or { ok: false, error }. */
async function saveTemplate(input, adminId) {
  const name = String(input?.name || '').replace(/\s+/g, ' ').trim();
  const kind = MODES.includes(input?.kind) ? input.kind : null;
  const dltId = String(input?.dlt_id || '').trim();
  const body = String(input?.body || '').replace(/\r/g, '').trim();
  const sender = String(input?.sender || '').trim().toUpperCase() || null;
  if (!name || name.length > 60) return { ok: false, error: 'Give the template a short name (up to 60 characters).' };
  if (!kind) return { ok: false, error: 'Choose whether it is a service notice or promotional.' };
  if (!/^\d{3,25}$/.test(dltId)) return { ok: false, error: 'The DLT message id is the number Fast2SMS shows for the approved template.' };
  if (!body || body.length > 500) return { ok: false, error: 'Paste the approved wording exactly, with {#var#} where each value goes.' };
  if (varsOf(body) > 5) return { ok: false, error: 'At most 5 {#var#} values.' };
  if (sender && !/^[A-Z0-9]{6}$/.test(sender)) return { ok: false, error: 'The header (sender id) is 6 letters or digits — or leave it empty for the usual one.' };
  try {
    const id = /^\d+$/.test(String(input?.key || '')) ? Number(input.key) : null;
    const r = id
      ? await db.one(`UPDATE sms_templates SET name = $2, kind = $3, dlt_id = $4, body = $5, sender = $6, modified_at = now()
                       WHERE id = $1 AND is_active RETURNING *`, [id, name, kind, dltId, body, sender])
      : await db.one(`INSERT INTO sms_templates (name, kind, dlt_id, body, sender, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [name, kind, dltId, body, sender, adminId || null]);
    return r ? { ok: true, template: await shape(r) } : { ok: false, error: 'That template is gone.' };
  } catch (e) {
    if (e.code === '23505') return { ok: false, error: 'A template with that DLT message id is already in the list.' };
    throw e;
  }
}

/** Take a template off the list (kept for the batches that used it). */
async function removeTemplate(key) {
  const { rowCount } = await db.query(`UPDATE sms_templates SET is_active = false, modified_at = now() WHERE id = $1`, [Number(key) || 0]);
  return { ok: rowCount > 0 };
}

const dayStart = () => {
  const ist = istNow();
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 3600e3);
};
async function sentToday() {
  const r = await db.one(`SELECT count(*)::int AS n FROM notify_queue WHERE channel = 'sms' AND kind IN ('promo', 'service')
                            AND note ~ '^(promo|service):' AND created_at >= $1 AND status <> 'cancelled'`, [dayStart()]);
  return r?.n || 0;
}

async function batches() {
  const { rows } = await db.query(
    `SELECT q.note AS batch, min(q.kind) AS kind, min(q.created_at) AS created_at, min(q.send_at) AS send_at, (array_agg(q.vals))[1] AS vals,
            (array_agg(t.name))[1] AS template,
            count(*)::int AS total,
            count(*) FILTER (WHERE q.status = 'queued')::int AS queued,
            count(*) FILTER (WHERE q.status = 'sent')::int AS sent,
            count(*) FILTER (WHERE q.status = 'skipped')::int AS skipped,
            count(*) FILTER (WHERE q.status = 'failed')::int AS failed,
            count(*) FILTER (WHERE q.status = 'cancelled')::int AS cancelled,
            (array_agg(a.name))[1] AS admin
       FROM notify_queue q LEFT JOIN admin_users a ON a.id = q.admin_id LEFT JOIN sms_templates t ON t.id = q.template_id
      WHERE q.channel = 'sms' AND q.kind IN ('promo', 'service') AND q.note ~ '^(promo|service):'
      GROUP BY q.note ORDER BY min(q.created_at) DESC LIMIT 20`);
  return rows;
}

/** The chosen template (or the first), every template to choose from, today's count and the batches. */
async function overview(key) {
  const t = await template(key);
  const cap = await settings.num('sms_promo_per_day', 500);
  const today = await sentToday();
  const ist = istNow().getUTCHours();
  return { mode: t?.mode || 'service', template: t, templates: await templates(), cap, today, left: Math.max(0, cap - today),
           in_window: ist >= 10 && ist < 21, batches: await batches() };
}

const FILTERS = {
  all: 'true',
  paid: `EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0)`,
  never_paid: `NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0)`,
  monitoring: `EXISTS (SELECT 1 FROM watches w WHERE w.user_id = u.id AND w.is_active)`,
  not_recent: `NOT EXISTS (SELECT 1 FROM notify_log nl WHERE nl.user_id = u.id AND nl.channel = 'sms' AND nl.kind IN ('promo', 'service')
                 AND nl.status IN ('sent', 'simulated') AND nl.created_at > now() - interval '7 days')`,
};

/** Who the mode may reach: agreed in this panel's channel (or the owner, to test) — and, for promo, opted in. */
async function recipients({ mode = 'promo', filter = 'all', q = '', limit = 1000 } = {}) {
  const m = modeOf(mode);
  const term = String(q || '').trim();
  const { rows } = await db.query(
    `SELECT u.id, right(regexp_replace(u.mobile, '\\D', '', 'g'), 10) AS mobile,
            coalesce(u.display_name, u.wa_profile_name) AS name, u.last_seen_at, u.promo_consent_at, u.is_internal,
            (${OPTED}) AS opted,
            (SELECT count(*)::int FROM user_vehicles uv WHERE uv.user_id = u.id AND uv.hidden_at IS NULL) AS vehicles,
            EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0) AS paid,
            (SELECT max(nl.created_at) FROM notify_log nl WHERE nl.user_id = u.id AND nl.channel = 'sms' AND nl.kind IN ('promo', 'service')
                AND nl.status IN ('sent', 'simulated')) AS last_promo_at
       FROM users u
      WHERE u.deactivated_at IS NULL AND u.erased_at IS NULL AND u.mobile IS NOT NULL
        AND ${m === 'promo' ? OPTED : 'true'}
        AND (${require('./consented').agreedSql('u.mobile')} OR u.is_internal)
        AND (${FILTERS[filter] || 'true'})
        AND ($1 = '' OR u.mobile LIKE '%' || $1 || '%' OR coalesce(u.display_name, u.wa_profile_name, '') ILIKE '%' || $1 || '%')
      ORDER BY u.last_seen_at DESC NULLS LAST
      LIMIT $2`, [term, Math.min(2000, Number(limit) || 1000)]);
  const total = await db.one(
    `SELECT count(*) FILTER (WHERE ${OPTED})::int AS opted, count(*)::int AS agreed
       FROM users u WHERE u.deactivated_at IS NULL AND u.erased_at IS NULL AND u.mobile IS NOT NULL
        AND (${require('./consented').agreedSql('u.mobile')} OR u.is_internal)`);
  return { mode: m, rows: rows.map((r) => ({ ...r, id: String(r.id) })), opted: total?.opted || 0, agreed: total?.agreed || 0, filters: Object.keys(FILTERS) };
}

/** Queue the batch. { ok, queued, not_opted, over_cap, send_at, batch } or { ok: false, error }. */
async function send({ template: key, userIds = [], vals = [], note = '' }, adminId) {
  if (!/^\d+$/.test(String(key || ''))) return { ok: false, error: 'Choose a template first.' };
  const t = await template(key);
  if (!t) return { ok: false, error: 'That template is not in the list any more.' };
  if (!t.sender) {
    return { ok: false, error: t.mode === 'promo' ? 'This promotional template has no header: give it one, or put your 6-digit promotional header in Settings (sms_promo_sender_id).'
      : 'The SMS sender id (FAST2SMS_SENDER_ID) is not set on the server — or give this template its own header.' };
  }
  const v = (vals || []).slice(0, t.vars).map((x) => String(x ?? '').replace(/\s+/g, ' ').trim());
  if (v.length !== t.vars || v.some((x) => !x)) return { ok: false, error: `The template needs all ${t.vars} value${t.vars === 1 ? '' : 's'}.` };
  const long = v.findIndex((x) => x.length > VAR_MAX);
  if (long >= 0) return { ok: false, error: `Value ${long + 1} is longer than ${VAR_MAX} characters — DLT would cut it.` };
  const size = smsLength(fill(t.text, v));
  if (size.length > size.limit) {
    return { ok: false, error: `The message is ${size.length} characters — one SMS holds ${size.limit}${size.unicode
      ? ' because it has a special character (like ₹, an emoji or Hindi); plain text allows 160' : ''}. Shorten it.` };
  }
  const ids = [...new Set((userIds || []).map(String).filter((x) => /^\d+$/.test(x)))];
  if (!ids.length) return { ok: false, error: 'Choose at least one customer.' };

  // Only those this mode's list may show — checked again here, never trusted from the browser.
  const allowed = new Set((await recipients({ mode: t.mode, limit: 2000 })).rows.map((r) => r.id));
  const go = ids.filter((id) => allowed.has(id));
  const cap = await settings.num('sms_promo_per_day', 500);
  const left = Math.max(0, cap - await sentToday());
  if (!left) return { ok: false, error: `Today's limit of ${cap} broadcast SMS is used up (Settings sms_promo_per_day).` };
  const take = go.slice(0, left);
  const at = nextWindow();
  const batch = `${t.mode}:${new Date().toISOString()}${note ? ` ${String(note).slice(0, 80)}` : ''}`;
  const { rows } = await db.query(
    `INSERT INTO notify_queue (channel, kind, user_id, mobile, vals, send_at, admin_id, note, template_id)
     SELECT 'sms', $6, u.id, right(regexp_replace(u.mobile, '\\D', '', 'g'), 10), $1::jsonb, $2, $3, $4, $7
       FROM users u WHERE u.id = ANY($5::bigint[])
     RETURNING id`, [JSON.stringify(v), at, adminId || null, batch, take, t.mode, Number(t.key)]);
  return { ok: true, mode: t.mode, template: t.name, queued: rows.length, not_opted: ids.length - go.length, over_cap: go.length - take.length,
           send_at: at, batch, preview: fill(t.text, v) };
}

async function cancel(batch) {
  const { rowCount } = await db.query(
    `UPDATE notify_queue SET status = 'cancelled', result = 'cancelled by an admin'
      WHERE channel = 'sms' AND kind IN ('promo', 'service') AND note = $1 AND status = 'queued'`, [String(batch || '')]);
  return { ok: true, cancelled: rowCount };
}

module.exports = { overview, recipients, send, cancel, fill, nextWindow, smsLength, template, templates, saveTemplate, removeTemplate, senderOf };
