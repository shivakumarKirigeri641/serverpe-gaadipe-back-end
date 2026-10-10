/**
 * src/admin/reach.js — SMS & NOTIFICATIONS for the web admin (user, 2026-10-10:
 * "SMS template for manual sends to specific users; SMS status for all users — yet
 * to send, sent, next to send; the web notifications the same"). Migration 155.
 *
 *   overview()   is SMS set up, which templates are approved, the manual template's
 *                wording, and the last 30 days by channel and outcome
 *   users()      every customer with, per channel: last sent (what, when, outcome),
 *                how many sent, what is queued next — and the next automatic
 *                message the jobs will send (expiry warning, monitoring ending)
 *   history()    one customer's SMS and notifications, newest first, with the queue
 *   queue()      a manual SMS (approved template) or notification to chosen
 *                customers, now or at a time; jobs/reach.js sends it
 *   cancel()     a queued one that has not gone yet
 */

const db = require('../db');
const settings = require('../util/settings');
const sms = require('../util/sms');

const n = (v) => Number(v || 0);
const ten = (m) => String(m || '').replace(/\D/g, '').slice(-10);
const SMS_KINDS = ['expiry', 'challan', 'monitor_end', 'service', 'offers', 'manual', 'status'];
const MANUAL_SMS = ['manual', 'service'];          // what the admin may send by hand

async function overview() {
  const templates = {};
  for (const k of SMS_KINDS) templates[k] = Boolean(String(await settings.get(`sms_tpl_${k}`, '') || '').trim());
  const { rows } = await db.query(
    `SELECT channel, status, count(*)::int AS n FROM notify_log
      WHERE created_at > now() - interval '30 days' GROUP BY 1, 2`);
  const last30 = { sms: {}, push: {} };
  for (const r of rows) (last30[r.channel] || (last30[r.channel] = {}))[r.status] = r.n;
  const q = await db.one(
    `SELECT count(*) FILTER (WHERE channel = 'sms')::int AS sms, count(*) FILTER (WHERE channel = 'push')::int AS push
       FROM notify_queue WHERE status IN ('queued', 'sending')`);
  const reach = await db.one(
    `SELECT (SELECT count(DISTINCT user_id) FROM customer_push_subscriptions)::int AS push_customers,
            (SELECT count(*) FROM users WHERE deactivated_at IS NULL AND erased_at IS NULL AND mobile IS NOT NULL)::int AS customers`);
  return {
    sms: {
      provider: sms.PROVIDER || null, configured: sms.configured(),
      alerts_enabled: await settings.bool('sms_alerts_enabled', false),
      templates,
      manual: {
        approved: templates.manual,
        text: String(await settings.get('sms_tpl_manual_text', '') || ''),
        vars: Math.max(0, await settings.num('sms_tpl_manual_vars', 1)),
      },
      service_text: 'The one-time notice (sms_tpl_service) — no variables.',
    },
    last30, queued: q, reach,
  };
}

/** The next message the automatic jobs will send this customer, if any — per vehicle watched. */
async function nextAuto(userIds) {
  if (!userIds.length) return {};
  const warn = String(await settings.get('expiry_warn_days', '30,7,1')).split(',').map(Number).filter((x) => x > 0).sort((a, b) => b - a);
  const renewalDays = await settings.num('renewal_notice_days', 3);
  const freeDays = await settings.num('free_monitor_notice_days', 2);
  const { rows } = await db.query(
    `SELECT w.user_id, w.expires_at, w.subscription_id, v.reg_no,
            v.insurance_upto, v.pucc_upto, v.tax_upto, v.fitness_upto, v.permit_upto
       FROM watches w JOIN vehicles v ON v.id = w.vehicle_id
      WHERE w.is_active AND w.user_id = ANY($1::bigint[])`, [userIds]);
  const today = new Date(new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10));
  const DOCS = [['insurance_upto', 'Insurance'], ['pucc_upto', 'PUC'], ['tax_upto', 'Road tax'], ['fitness_upto', 'Fitness'], ['permit_upto', 'Permit']];
  const out = {};
  const offer = (uid, at, what) => {
    if (!at || at < today) return;
    if (!out[uid] || at < new Date(out[uid].at)) out[uid] = { at: at.toISOString().slice(0, 10), what };
  };
  for (const r of rows) {
    if (r.expires_at) {
      const lead = r.subscription_id ? renewalDays : freeDays;
      const at = new Date(new Date(r.expires_at).getTime() - lead * 86400e3);
      offer(r.user_id, new Date(at.toISOString().slice(0, 10)), `${r.reg_no}: monitoring ends ${new Date(r.expires_at).toISOString().slice(0, 10)}`);
    }
    for (const [col, label] of DOCS) {
      if (!r[col]) continue;
      const d = new Date(new Date(r[col]).toISOString().slice(0, 10));
      for (const t of warn) {
        const at = new Date(d.getTime() - t * 86400e3);
        if (at >= today) { offer(r.user_id, at, `${r.reg_no}: ${label} expires in ${t} day${t === 1 ? '' : 's'}`); break; }
      }
    }
  }
  return out;
}

async function users({ q = '', filter = 'all', limit = 200 } = {}) {
  const term = String(q || '').trim().replace(/[%_]/g, '');
  const F = {
    all: 'true',
    sms_never: 's.sent IS NULL OR s.sent = 0',
    sms_sent: 's.sent > 0',
    sms_failed: `s.last_status IN ('failed', 'skipped')`,
    queued: 'qs.next_at IS NOT NULL OR qp.next_at IS NOT NULL',
    push_on: 'pd.devices > 0',
    push_never: 'p.sent IS NULL OR p.sent = 0',
  }[filter] || 'true';
  const { rows } = await db.query(
    `WITH s AS (
       SELECT user_id, count(*) FILTER (WHERE status IN ('sent', 'simulated'))::int AS sent,
              (array_agg(kind ORDER BY created_at DESC))[1] AS last_kind, (array_agg(status ORDER BY created_at DESC))[1] AS last_status,
              (array_agg(error ORDER BY created_at DESC))[1] AS last_error, max(created_at) AS last_at
         FROM notify_log WHERE channel = 'sms' AND user_id IS NOT NULL GROUP BY user_id),
     p AS (
       SELECT user_id, count(*) FILTER (WHERE status = 'sent')::int AS sent,
              (array_agg(kind ORDER BY created_at DESC))[1] AS last_kind, (array_agg(status ORDER BY created_at DESC))[1] AS last_status,
              (array_agg(error ORDER BY created_at DESC))[1] AS last_error, max(created_at) AS last_at
         FROM notify_log WHERE channel = 'push' AND user_id IS NOT NULL GROUP BY user_id),
     qs AS (SELECT user_id, min(send_at) AS next_at, (array_agg(kind ORDER BY send_at))[1] AS next_kind, count(*)::int AS n
              FROM notify_queue WHERE channel = 'sms' AND status IN ('queued', 'sending') GROUP BY user_id),
     qp AS (SELECT user_id, min(send_at) AS next_at, (array_agg(coalesce(title, kind) ORDER BY send_at))[1] AS next_kind, count(*)::int AS n
              FROM notify_queue WHERE channel = 'push' AND status IN ('queued', 'sending') GROUP BY user_id),
     pd AS (SELECT user_id, count(*)::int AS devices FROM customer_push_subscriptions GROUP BY user_id)
     SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.email, u.email_verified_at, u.is_internal,
            (u.promo_consent_at IS NOT NULL AND u.promo_consent_withdrawn_at IS NULL) AS offers_ok,
            coalesce(pd.devices, 0) AS push_devices,
            s.sent AS sms_sent, s.last_kind AS sms_last_kind, s.last_status AS sms_last_status, s.last_error AS sms_last_error, s.last_at AS sms_last_at,
            qs.next_at AS sms_next_at, qs.next_kind AS sms_next_kind, qs.n AS sms_queued,
            p.sent AS push_sent, p.last_kind AS push_last_kind, p.last_status AS push_last_status, p.last_error AS push_last_error, p.last_at AS push_last_at,
            qp.next_at AS push_next_at, qp.next_kind AS push_next_kind, qp.n AS push_queued,
            (SELECT count(*) FROM watches w WHERE w.user_id = u.id AND w.is_active)::int AS watching,
            greatest(u.last_seen_at, s.last_at, p.last_at) AS active_at
       FROM users u
       LEFT JOIN s ON s.user_id = u.id LEFT JOIN p ON p.user_id = u.id
       LEFT JOIN qs ON qs.user_id = u.id LEFT JOIN qp ON qp.user_id = u.id
       LEFT JOIN pd ON pd.user_id = u.id
      WHERE u.deactivated_at IS NULL AND u.erased_at IS NULL AND u.mobile IS NOT NULL
        AND ($1 = '' OR u.mobile LIKE '%' || $1 || '%' OR coalesce(u.display_name, u.wa_profile_name, '') ILIKE '%' || $1 || '%')
        AND (${F})
      ORDER BY coalesce(qs.next_at, qp.next_at) NULLS LAST, active_at DESC NULLS LAST
      LIMIT $2`, [term, Math.min(1000, Number(limit) || 200)]);
  const auto = await nextAuto(rows.map((r) => r.id));
  return {
    rows: rows.map((r) => ({
      ...r, id: String(r.id), mobile: ten(r.mobile), push_devices: n(r.push_devices),
      sms_sent: n(r.sms_sent), push_sent: n(r.push_sent), sms_queued: n(r.sms_queued), push_queued: n(r.push_queued),
      next_auto: auto[r.id] || null,
    })),
  };
}

async function history(userId) {
  const { rows: log } = await db.query(
    `SELECT id, created_at, channel, kind, status, error, preview, devices, queue_id FROM notify_log
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [userId]);
  const { rows: queue } = await db.query(
    `SELECT id, created_at, channel, kind, vals, title, body, send_at, status, result, sent_at FROM notify_queue
      WHERE user_id = $1 ORDER BY send_at DESC LIMIT 100`, [userId]);
  return { log: log.map((x) => ({ ...x, id: String(x.id) })), queue: queue.map((x) => ({ ...x, id: String(x.id) })) };
}

/**
 * Queue a manual send to chosen customers. SMS: an approved template only
 * (manual, or the one-time service notice), its variables in order. Notification:
 * a title and a line. send_at: now, or a time (IST is what the admin typed).
 */
async function queue({ channel, kind = 'manual', userIds = [], vals = [], title, body, url, sendAt, adminId, note }) {
  const ids = [...new Set((userIds || []).map((x) => String(x)).filter((x) => /^\d+$/.test(x)))].slice(0, 1000);
  if (!ids.length) return { ok: false, error: 'Choose at least one customer.' };
  const at = sendAt ? new Date(sendAt) : new Date();
  if (Number.isNaN(at.getTime())) return { ok: false, error: 'That send time is not a date.' };
  if (channel === 'sms') {
    if (!MANUAL_SMS.includes(kind)) return { ok: false, error: 'Only the manual SMS or the one-time notice can be sent by hand.' };
    const id = String(await settings.get(`sms_tpl_${kind}`, '') || '').trim();
    if (!id) return { ok: false, error: `The ${kind === 'manual' ? 'manual SMS' : 'notice'} template is not approved yet — put its DLT message id in Settings (sms_tpl_${kind}) first.` };
    const want = kind === 'manual' ? Math.max(0, await settings.num('sms_tpl_manual_vars', 1)) : 0;
    const v = (vals || []).map((x) => String(x ?? '').trim()).slice(0, want);
    if (v.length !== want || v.some((x) => !x)) return { ok: false, error: `This template needs ${want} value${want === 1 ? '' : 's'}.` };
    const { rows } = await db.query(
      `INSERT INTO notify_queue (channel, kind, user_id, mobile, vals, send_at, admin_id, note)
       SELECT 'sms', $1, u.id, right(regexp_replace(u.mobile, '\\D', '', 'g'), 10), $2::jsonb, $3, $4, $5
         FROM users u WHERE u.id = ANY($6::bigint[]) AND u.deactivated_at IS NULL AND u.erased_at IS NULL AND u.mobile IS NOT NULL
       RETURNING id`, [kind, JSON.stringify(v), at, adminId || null, note || null, ids]);
    return { ok: true, queued: rows.length, send_at: at };
  }
  if (channel === 'push') {
    const t = String(title || '').trim().slice(0, 100);
    const b = String(body || '').trim().slice(0, 300);
    if (!t || !b) return { ok: false, error: 'A notification needs a title and a line.' };
    const link = String(url || '/chat').startsWith('/') ? String(url || '/chat').slice(0, 200) : '/chat';
    const { rows } = await db.query(
      `INSERT INTO notify_queue (channel, kind, user_id, title, body, url, send_at, admin_id, note)
       SELECT 'push', 'manual', u.id, $1, $2, $3, $4, $5, $6
         FROM users u WHERE u.id = ANY($7::bigint[]) AND u.deactivated_at IS NULL AND u.erased_at IS NULL
       RETURNING id`, [t, b, link, at, adminId || null, note || null, ids]);
    return { ok: true, queued: rows.length, send_at: at };
  }
  return { ok: false, error: 'Choose SMS or notification.' };
}

async function cancel(id) {
  const { rowCount } = await db.query(`UPDATE notify_queue SET status = 'cancelled', result = 'cancelled by an admin' WHERE id = $1 AND status = 'queued'`, [id]);
  return { ok: rowCount > 0 };
}

module.exports = { overview, users, history, queue, cancel };
