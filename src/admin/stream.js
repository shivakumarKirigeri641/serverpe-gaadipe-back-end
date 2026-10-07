/**
 * src/admin/stream.js — THE WEB ADMIN'S LIVE STREAM (user, 2026-10-07; spec
 * §43, §100–101, §110). One shared ticker, running only while an admin is
 * watching, turns what the rest of GaadiPe already records into a live feed:
 *
 *   every 2 s   what happened since the last tick — visits, pages, taps, chat
 *               checks, sign-in steps, website checks, payments started and paid,
 *               API calls and failures, alerts raised or repeated
 *   every 4 s   PRESENCE: who is on the website now, on which step and section,
 *               ONLINE / IDLE / HIDDEN, with the counts the header shows
 *   every 10 s  a ping, so the panel knows the line is alive (LIVE vs STALE)
 *
 * The customer's request never waits on any of this: the site writes its rows
 * as it always did, and this reads them on its own clock (spec §101). Sent
 * through the encrypted tunnel (security/tunnel.js /_s), each event sealed with
 * the admin browser's own key. Mobiles masked for roles without 'pii'.
 */

const db = require('../db');
const auth = require('./auth');
const settings = require('../util/settings');
const { statusOf } = require('../site/presence');

const subs = new Set();          // { write, pii, adminId }
let cur = null;                  // cursors: the last id seen per table
let lastTick = new Date();
let timer = null;
let tickN = 0;
let presenceCache = null;

const mask = (m) => { const d = String(m || '').replace(/\D/g, ''); return d.length >= 10 ? `${d.slice(-10, -8)}******${d.slice(-2)}` : m || null; };

async function cursors() {
  const r = await db.one(
    `SELECT (SELECT coalesce(max(id), 0) FROM events) AS ev, (SELECT coalesce(max(id), 0) FROM site_sign_ins) AS si,
            (SELECT coalesce(max(id), 0) FROM event_log) AS el, (SELECT coalesce(max(id), 0) FROM payments) AS pay,
            (SELECT coalesce(max(id), 0) FROM api_calls) AS api`);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]));
}

/* What happened since the last tick, as one list of plain items, oldest first. */
async function feed() {
  const since = lastTick; const now = new Date();
  const [ev, si, el, payNew, payOk, api, alerts] = await Promise.all([
    db.query(`SELECT id, occurred_at AS at, name, channel, visitor_id, session_id, user_id, mobile, reg_no, page, source,
                     amount_paise, status, metadata->>'label' AS label, metadata->>'kind' AS ikind, metadata->>'section' AS section
                FROM events WHERE id > $1 ORDER BY id LIMIT 400`, [cur.ev]),
    db.query(`SELECT id, created_at AS at, event, user_id, mobile, device_model, browser, city FROM site_sign_ins WHERE id > $1 ORDER BY id LIMIT 200`, [cur.si]),
    db.query(`SELECT e.id, e.created_at AS at, e.kind, e.user_id, u.mobile, e.detail->>'reg_no' AS reg_no,
                     (e.detail->>'found')::boolean AS found, e.detail->>'channel' AS ch, e.detail->>'device' AS device
                FROM event_log e LEFT JOIN users u ON u.id = e.user_id
               WHERE e.id > $1 AND e.kind IN ('chat_anon_check', 'vehicle_check', 'vehicle_check_repeat', 'full_view')
               ORDER BY e.id LIMIT 200`, [cur.el]),
    db.query(`SELECT p.id, p.created_at AS at, p.amount_paise, p.status, p.raw->>'channel' AS ch, p.raw->>'reg_no' AS reg_no, p.user_id, u.mobile
                FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE p.id > $1 ORDER BY p.id LIMIT 100`, [cur.pay]),
    db.query(`SELECT p.id, p.paid_at AS at, p.amount_paise, p.raw->>'channel' AS ch, p.raw->>'reg_no' AS reg_no, p.user_id, u.mobile
                FROM payments p LEFT JOIN users u ON u.id = p.user_id
               WHERE p.status = 'paid' AND p.paid_at > $1 AND p.paid_at <= $2 ORDER BY p.paid_at LIMIT 100`, [since, now]),
    db.query(`SELECT id, created_at AS at, dataset, reg_no, ok, cache_hit, duration_ms, outcome, coalesce(error_message, error_code) AS err
                FROM api_calls WHERE id > $1 ORDER BY id LIMIT 500`, [cur.api]),
    db.query(`SELECT id, last_seen_at AS at, severity, title, source, seen_count, status FROM admin_alerts
               WHERE last_seen_at > $1 AND last_seen_at <= $2 AND status <> 'resolved' ORDER BY last_seen_at LIMIT 50`, [since, now]).catch(() => ({ rows: [] })),
  ]);
  lastTick = now;
  if (ev.rows.length) cur.ev = String(ev.rows.at(-1).id);
  if (si.rows.length) cur.si = String(si.rows.at(-1).id);
  if (el.rows.length) cur.el = String(el.rows.at(-1).id);
  if (payNew.rows.length) cur.pay = String(payNew.rows.at(-1).id);
  if (api.rows.length) cur.api = String(api.rows.at(-1).id);

  const items = [];
  for (const e of ev.rows) {
    const kind = e.name === 'page_view' ? 'page' : e.name === 'interaction' ? 'interaction' : e.name === 'session_started' ? 'visit'
      : /payment/.test(e.name) ? 'payment' : /report/.test(e.name) ? 'report' : e.channel === 'whatsapp' ? 'whatsapp' : 'event';
    if (e.name === 'payment_success') continue;     // said by the payments query, with the amount
    items.push({ key: `ev${e.id}`, at: e.at, kind, name: e.name, session_id: e.session_id, visitor_id: e.visitor_id,
      user_id: e.user_id ? String(e.user_id) : null, mobile: e.mobile, reg_no: e.reg_no, page: e.page, source: e.source,
      label: e.label, ikind: e.ikind, section: e.section, ok: e.status !== 'failed' });
  }
  for (const s of si.rows) {
    items.push({ key: `si${s.id}`, at: s.at, kind: 'signin', name: s.event, user_id: s.user_id ? String(s.user_id) : null, mobile: s.mobile,
      detail: [s.device_model, s.browser, s.city].filter(Boolean).join(' · '), ok: !/failed|refused/.test(s.event) });
  }
  for (const x of el.rows) {
    items.push({ key: `el${x.id}`, at: x.at, kind: x.kind === 'chat_anon_check' ? 'chat' : 'check', name: x.kind,
      user_id: x.user_id ? String(x.user_id) : null, mobile: x.mobile, reg_no: x.reg_no, ok: x.found !== false, detail: x.kind === 'chat_anon_check' ? 'free, not signed in' : x.ch === 'web' ? 'website' : '' });
  }
  for (const p of payNew.rows) {
    items.push({ key: `pn${p.id}`, at: p.at, kind: 'payment', name: 'payment_started', payment_id: String(p.id), amount_paise: p.amount_paise,
      user_id: p.user_id ? String(p.user_id) : null, mobile: p.mobile, reg_no: p.reg_no, detail: p.ch || '', ok: true });
  }
  for (const p of payOk.rows) {
    items.push({ key: `po${p.id}`, at: p.at, kind: 'payment', name: 'payment_success', payment_id: String(p.id), amount_paise: p.amount_paise,
      user_id: p.user_id ? String(p.user_id) : null, mobile: p.mobile, reg_no: p.reg_no, detail: p.ch || '', ok: true, severity: 'success' });
  }
  const apiFails = api.rows.filter((a) => !a.ok);
  for (const a of apiFails.slice(-20)) {
    items.push({ key: `api${a.id}`, at: a.at, kind: 'api', name: 'api_failed', reg_no: a.reg_no, detail: `${a.dataset}: ${a.outcome || 'failed'}${a.err ? ` — ${String(a.err).slice(0, 80)}` : ''}`, ok: false });
  }
  for (const a of alerts.rows) {
    items.push({ key: `al${a.id}:${a.seen_count}`, at: a.at, kind: 'alert', name: 'alert', alert_id: String(a.id), severity: a.severity,
      detail: a.title, source: a.source, count: a.seen_count, ok: !['critical', 'warning'].includes(a.severity) });
  }
  items.sort((a, b) => new Date(a.at) - new Date(b.at));
  return { items, api: { calls: api.rows.length, failed: apiFails.length, cached: api.rows.filter((a) => a.cache_hit).length } };
}

/* Who is on the website now (spec §6–7). */
async function presence() {
  const idleS = await settings.num('web_idle_seconds', 60);
  const offlineS = await settings.num('web_offline_seconds', 75);
  const { rows } = await db.query(
    `SELECT w.session_id, w.visitor_id, w.user_id, w.started_at, w.last_seen_at, w.last_action_at, w.ended_at, w.end_reason,
            w.page, w.step, w.action, w.section, w.scroll_pct, w.visible, w.pages, w.interactions, w.source, w.campaign,
            w.device, w.place, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
            (SELECT count(*) FROM web_sessions o WHERE o.visitor_id = w.visitor_id AND o.started_at < w.started_at) AS earlier
       FROM web_sessions w LEFT JOIN users u ON u.id = w.user_id
      WHERE w.last_seen_at > now() - make_interval(secs => $1) AND w.ended_at IS NULL
      ORDER BY w.last_seen_at DESC LIMIT 300`, [offlineS]);
  const now = Date.now();
  const list = rows.map((r) => ({ ...r, user_id: r.user_id ? String(r.user_id) : null, returning: Number(r.earlier) > 0,
    status: statusOf(r, { idleS, offlineS, now }) })).filter((r) => r.status !== 'OFFLINE');
  const c = (f) => list.filter(f).length;
  return {
    at: new Date().toISOString(),
    counts: {
      active: list.length, online: c((r) => r.status === 'ONLINE'), idle: c((r) => r.status === 'IDLE'), hidden: c((r) => r.status === 'HIDDEN'),
      signed_in: c((r) => r.user_id), anonymous: c((r) => !r.user_id),
      checking: c((r) => /check|viewing/.test(r.step || '')), signing_in: c((r) => /mobile|code|sign/.test(r.step || '')),
      at_payment: c((r) => /pay/.test(r.step || '')),
    },
    rows: list,
  };
}

function broadcast(msg) {
  for (const s of subs) {
    const body = s.pii ? msg : JSON.parse(JSON.stringify(msg, (k, v) => (k === 'mobile' ? mask(v) : v)));
    if (!s.write(body)) subs.delete(s);
  }
}

async function tick() {
  if (!subs.size) { clearInterval(timer); timer = null; return; }
  tickN += 1;
  try {
    if (!cur) { cur = await cursors(); lastTick = new Date(); }
    const f = await feed();
    if (f.items.length || f.api.calls) broadcast({ type: 'feed', ...f });
    if (tickN % 2 === 0) { presenceCache = await presence(); broadcast({ type: 'presence', ...presenceCache }); }
    if (tickN % 5 === 0) broadcast({ type: 'ping', at: new Date().toISOString(), watchers: subs.size });
  } catch (e) {
    console.error('[admin-stream] %s', e.message);
  }
}

/**
 * The tunnel's stream handler (app.js): checks the admin's session, then keeps
 * the answer open. Each stream lasts at most 20 minutes — the page reconnects,
 * which also renews its key before the tunnel would refuse it.
 */
async function handle(req, res, write) {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const session = await auth.sessionFor(token).catch(() => null);
  if (!session) return res.status(401).json({ error: 'signed_out' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const sub = { write, pii: auth.can(session.role, 'pii'), adminId: session.id };
  subs.add(sub);
  write({ type: 'hello', at: new Date().toISOString(), admin: session.name });
  // The current picture straight away, not after the first tick.
  try { write({ type: 'presence', ...(presenceCache && Date.now() - new Date(presenceCache.at) < 5000 ? presenceCache : await presence()) }); } catch { /* the tick will */ }
  if (!timer) timer = setInterval(tick, 2000);
  const end = () => { subs.delete(sub); clearTimeout(limit); };
  const limit = setTimeout(() => { try { res.end(); } catch { /* gone */ } end(); }, 20 * 60 * 1000);
  req.on('close', end);
}

module.exports = { handle, presence, watchers: () => subs.size };
