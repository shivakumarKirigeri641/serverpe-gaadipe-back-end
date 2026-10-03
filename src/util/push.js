/**
 * src/util/push.js — notifications on the admin's phone (user, 2026-10-03).
 *
 * Web Push: the admin panel, opened once on the phone (or added to its home
 * screen) and switched on in Display & motion, receives notifications even
 * with the browser closed — payments, 4–5 star feedback, customer milestones,
 * critical alerts, and the pings in util/adminPing.js (VAHAN back or down,
 * RC backup paused, the Monday summary).
 *
 * The VAPID key pair is made on first use and kept in app_settings; nothing
 * to configure. A subscription the push service says is gone (404 / 410) is
 * removed; one that fails five times in a row is dropped too.
 */

const webpush = require('web-push');
const db = require('../db');
const settings = require('./settings');

let ready = null;
async function keys() {
  if (ready) return ready;
  let pub = await settings.get('vapid_public', '');
  let priv = await settings.get('vapid_private', '');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey; priv = k.privateKey;
    for (const [key, value] of [['vapid_public', pub], ['vapid_private', priv]]) {
      await db.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, value]);
    }
    settings.refresh();
    pub = await settings.get('vapid_public', pub); priv = await settings.get('vapid_private', priv);
  }
  const subject = `mailto:${process.env.ADMINMAIL || 'support@gaadipe.in'}`.split(',')[0];
  webpush.setVapidDetails(subject, pub, priv);
  ready = { publicKey: pub };
  return ready;
}

const publicKey = async () => (await keys()).publicKey;

async function subscribe(adminId, sub, device) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw Object.assign(new Error('Not a push subscription.'), { status: 400 });
  await db.query(
    `INSERT INTO push_subscriptions (admin_id, endpoint, keys, device) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET admin_id = EXCLUDED.admin_id, keys = EXCLUDED.keys, device = EXCLUDED.device, failures = 0`,
    [adminId || null, sub.endpoint, JSON.stringify(sub.keys), String(device || '').slice(0, 200)]);
  return { ok: true };
}

async function unsubscribe(endpoint) {
  await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
  return { ok: true };
}

async function list(adminId) {
  const { rows } = await db.query(
    `SELECT id, device, created_at, last_ok_at, failures FROM push_subscriptions WHERE admin_id = $1 ORDER BY id DESC`, [adminId]);
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

// Titles sent in the last ten minutes, so an alert pinged directly (util/adminPing)
// is not sent again when the feed sees the same alert.
const recent = new Map();
const seenRecently = (t) => { const at = recent.get(t); return at && Date.now() - at < 10 * 60000; };

/** Send one notification to every subscribed device (or one admin's). */
async function toAdmins({ title, body, tag, url = '/', adminId = null }) {
  const { rows } = await db.query(
    `SELECT id, endpoint, keys FROM push_subscriptions WHERE ($1::bigint IS NULL OR admin_id = $1)`, [adminId]);
  recent.set(String(title), Date.now());
  if (!rows.length) return 0;
  await keys();
  const payload = JSON.stringify({ title: String(title).slice(0, 120), body: String(body || '').slice(0, 400), tag: tag || undefined, url });
  let sent = 0;
  for (const s of rows) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 3600, urgency: 'high' });
      await db.query(`UPDATE push_subscriptions SET last_ok_at = now(), failures = 0 WHERE id = $1`, [s.id]);
      sent += 1;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]);
      } else {
        await db.query(`UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1`, [s.id]);
        await db.query(`DELETE FROM push_subscriptions WHERE id = $1 AND failures >= 5`, [s.id]);
        console.warn('[push] send failed (%s): %s', e.statusCode || '', e.body || e.message);
      }
    }
  }
  return sent;
}

/*
 * THE FEED, ON THE PHONE. Each pass sends what is new since the last one —
 * payments, feedback, milestones and critical alerts — the same items the
 * panel pops up. The watermark lives in app_settings, so a restart neither
 * repeats nor drops anything.
 */
async function feed() {
  const any = await db.one(`SELECT 1 AS x FROM push_subscriptions LIMIT 1`);
  if (!any) return 0;
  const since = await settings.get('push_feed_since', '') || new Date(Date.now() - 60000).toISOString();
  const out = await require('../admin/alerts').feed(since);
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ('push_feed_since', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [out.at]);
  settings.refresh();
  const T = require('../mail/templates');
  let n = 0;
  for (const i of out.items) {
    let msg = null;
    if (i.kind === 'payment') msg = { title: `💰 Payment · ${T.rupees(i.amount_paise)}`, body: [i.person, i.reg_no].filter(Boolean).join(' · '), url: '/payments' };
    else if (i.kind === 'feedback') msg = { title: `${'⭐'.repeat(Math.max(1, Math.min(5, Number(i.rating) || 0)))} Feedback`, body: i.text || i.title || '', url: '/feedback' };
    else if (i.kind === 'milestone') msg = { title: `🎉 ${Number(i.customers).toLocaleString('en-IN')} customers`, body: 'A new GaadiPe milestone.', url: '/' };
    else if (i.kind === 'alert' && i.severity === 'critical' && !seenRecently(i.title)) msg = { title: `⚠️ ${i.title}`, body: i.text || '', url: '/alerts' };
    if (msg) n += await toAdmins({ ...msg, tag: i.id });
  }
  return n;
}

module.exports = { publicKey, subscribe, unsubscribe, list, toAdmins, feed };
