/**
 * src/site/push.js — NOTIFICATIONS ON THE CUSTOMER'S PHONE (user, 2026-10-07:
 * "after sign in, ask for browser notifications"; "tapping it opens the chat").
 *
 *   subscribe(userId, sub, device)   this browser / installed app may be notified
 *   unsubscribe(userId, endpoint)    stop (sign-out, deactivation, switched off)
 *   forget(userId)                   every device of this customer (deactivation)
 *   toCustomer(userId, msg)          { title, body, url, tag } to each of their devices
 *   status(userId)                   how many devices are on
 *
 * The same VAPID keys as the admin's notifications (util/push.js — made on
 * first use, kept in app_settings), but a SEPARATE table: the admin feed sends
 * to every row of push_subscriptions, and no customer may get those. A
 * subscription the push service says is gone (404/410) is removed; five
 * failures in a row drop it. Tapping a notification opens /chat (public/sw.js).
 */

const webpush = require('web-push');
const db = require('../db');
const adminPush = require('../util/push');

const valid = (sub) => sub?.endpoint && /^https:\/\//.test(sub.endpoint) && sub?.keys?.p256dh && sub?.keys?.auth;

async function subscribe(userId, sub, device) {
  if (!valid(sub)) throw Object.assign(new Error('Not a push subscription.'), { status: 400 });
  await db.query(
    `INSERT INTO customer_push_subscriptions (user_id, endpoint, keys, device) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys, device = EXCLUDED.device, failures = 0`,
    [userId, sub.endpoint, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }), String(device || '').slice(0, 200)]);
  return { ok: true };
}

async function unsubscribe(userId, endpoint) {
  await db.query(`DELETE FROM customer_push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, String(endpoint || '')]);
  return { ok: true };
}

async function forget(userId) {
  await db.query(`DELETE FROM customer_push_subscriptions WHERE user_id = $1`, [userId]);
}

async function status(userId) {
  const r = await db.one(`SELECT count(*)::int AS n FROM customer_push_subscriptions WHERE user_id = $1`, [userId]);
  return { devices: r.n };
}

/** One notification to each of this customer's devices. Returns how many were delivered to the push service. */
async function toCustomer(userId, { title, body, url = '/chat', tag, kind, queueId = null, adminId = null }) {
  const sent = await toCustomerRaw(userId, { title, body, url, tag });
  /* THE RECORD (migration 155): every notification, for the web admin's SMS & notifications page. */
  try {
    const devices = sent === -1 ? 0 : sent;
    await db.query(
      `INSERT INTO notify_log (channel, kind, user_id, status, error, preview, devices, queue_id, admin_id)
            VALUES ('push', $1, $2, $3, $4, $5, $6, $7, $8)`,
      [String(kind || tag || 'notification').replace(/[-:].*$/, '').slice(0, 40), userId,
        sent === -1 ? 'no_device' : sent > 0 ? 'sent' : 'failed', sent === -1 ? 'no notification device' : sent > 0 ? null : 'no device accepted it',
        `${String(title || '').slice(0, 100)} — ${String(body || '').slice(0, 180)}`, devices, queueId, adminId]);
  } catch (e) { console.error('[customer-push] log failed: %s', e.message); }
  return Math.max(0, sent);
}

/** -1 when the customer has no notification device. */
async function toCustomerRaw(userId, { title, body, url = '/chat', tag }) {
  const { rows } = await db.query(`SELECT id, endpoint, keys FROM customer_push_subscriptions WHERE user_id = $1`, [userId]);
  if (!rows.length) return -1;
  await adminPush.publicKey();                       // sets the VAPID details
  const payload = JSON.stringify({ title: String(title || 'GaadiPe').slice(0, 120), body: String(body || '').slice(0, 400),
                                   url: String(url || '/chat').startsWith('/') ? url : '/chat', tag: tag || undefined });
  let sent = 0;
  for (const s of rows) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 24 * 3600, urgency: 'normal' });
      await db.query(`UPDATE customer_push_subscriptions SET last_ok_at = now(), failures = 0 WHERE id = $1`, [s.id]);
      sent += 1;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.query(`DELETE FROM customer_push_subscriptions WHERE id = $1`, [s.id]);
      } else {
        await db.query(`UPDATE customer_push_subscriptions SET failures = failures + 1 WHERE id = $1`, [s.id]);
        await db.query(`DELETE FROM customer_push_subscriptions WHERE id = $1 AND failures >= 5`, [s.id]);
        console.warn('[customer-push] send failed (%s): %s', e.statusCode || '', e.body || e.message);
      }
    }
  }
  return sent;
}

module.exports = { publicKey: adminPush.publicKey, subscribe, unsubscribe, forget, status, toCustomer };
