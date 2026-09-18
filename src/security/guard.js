/**
 * src/security/guard.js — rate limits, loop and scraping detection, automation
 * tools, and the record of all of it (user, 2026-09-18).
 *
 * In memory, per process: counters are cheap and forgetting them on a restart
 * is harmless. What must survive — the events themselves — goes to the
 * security_events table, and the notify job emails the admin.
 *
 * An IP that crosses a hard line (a scraping pattern, a flood) is refused for
 * `temp_block_minutes`; lighter trouble (one burst, one loop) is answered 429
 * and allowed to carry on once it slows down.
 */

const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');

const now = () => Date.now();

/* ─────────────────────────────────────────────── sliding-window counters ── */
const windows = new Map();          // key -> array of timestamps
function hit(key, windowMs) {
  const t = now();
  const list = (windows.get(key) || []).filter((x) => t - x < windowMs);
  list.push(t);
  windows.set(key, list);
  return list.length;
}
const distinct = new Map();         // key -> Map(value -> ts)
function distinctCount(key, value, windowMs) {
  const t = now();
  const m = distinct.get(key) || new Map();
  for (const [v, ts] of m) if (t - ts > windowMs) m.delete(v);
  m.set(value, t);
  distinct.set(key, m);
  return m.size;
}
const blockedUntil = new Map();     // ip -> ms
setInterval(() => {                  // keep memory bounded
  const t = now();
  for (const [k, list] of windows) if (!list.length || t - list[list.length - 1] > 10 * 60 * 1000) windows.delete(k);
  for (const [k, m] of distinct) if (!m.size) distinct.delete(k);
  for (const [ip, until] of blockedUntil) if (until < t) blockedUntil.delete(ip);
}, 60 * 1000).unref();

/* ───────────────────────────────────────────────────────────── recording ── */
const lastLogged = new Map();       // kind|ip -> ms, so one flood is one row a minute, not thousands
async function record(kind, req, { severity = 'warn', surface = null, detail = {}, user = null } = {}) {
  const ip = req?.ip || null;
  const k = `${kind}|${ip}`;
  if (now() - (lastLogged.get(k) || 0) < 60 * 1000) return;
  lastLogged.set(k, now());
  try {
    await db.query(
      `INSERT INTO security_events (kind, severity, surface, ip, user_id, mobile, path, user_agent, detail)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [kind, severity, surface, ip, user?.id || req?.user?.id || null, user?.mobile || req?.user?.mobile || null,
       String(req?.originalUrl || '').slice(0, 300), String(req?.get?.('user-agent') || '').slice(0, 400),
       JSON.stringify(detail)]);
  } catch (e) {
    console.error('[security] could not record %s: %s', kind, e.message);
  }
  console.warn('[security] %s from %s %s', kind, ip, JSON.stringify(detail).slice(0, 200));
}

async function blockIp(req, minutesSetting = 'temp_block_minutes') {
  const minutes = await settings.num(minutesSetting, 30);
  blockedUntil.set(req.ip, now() + minutes * 60 * 1000);
}

/* ───────────────────────────────────────────────────────────── the guard ── */
const BOT_UA = /curl|wget|python|requests|httpx|aiohttp|scrapy|go-http|java\/|okhttp|libwww|httpclient|axios\/|node-fetch|postman|insomnia|headless|phantomjs|selenium|puppeteer|playwright/i;

/**
 * Before anything else on an API surface: refused IPs, automation tools, and
 * the per-IP request rate. `surface` is 'site' or 'admin'.
 */
function gate(surface) {
  return async (req, res, next) => {
    try {
      const until = blockedUntil.get(req.ip);
      if (until && until > now()) {
        return res.status(429).json({ error: 'blocked', message: 'Too many requests. Please try again later.' });
      }

      if (surface === 'site' && String(await settings.get('block_automation_tools', 'true')) === 'true') {
        const ua = req.get('user-agent') || '';
        if (!ua || BOT_UA.test(ua)) {
          await record('bot', req, { surface, severity: 'high', detail: { user_agent: ua || '(none)' } });
          return res.status(403).json({ error: 'forbidden', message: 'This client is not allowed.' });
        }
      }

      const isHandshake = req.path === '/_hs';
      const limit = await settings.num(isHandshake ? 'rate_limit_handshakes_per_minute_ip' : 'rate_limit_per_minute_ip',
        isHandshake ? 20 : 150);
      const n = hit(`${surface}:${isHandshake ? 'hs' : 'all'}:${req.ip}`, 60 * 1000);
      if (n > limit) {
        await record('rate_limit', req, { surface, detail: { per_minute: n, limit, handshake: isHandshake } });
        if (n > limit * 3) {                           // a flood, not a burst
          await blockIp(req);
          await record('blocked_ip', req, { surface, severity: 'high', detail: { per_minute: n } });
        }
        return res.status(429).json({ error: 'slow_down', message: 'Too many requests. Please wait a moment.' });
      }
      return next();
    } catch (e) {
      console.error('[security] gate:', e.message);
      return next();                                   // the guard must never take the site down
    }
  };
}

/**
 * After the envelope is opened (so the real path and body are known): the same
 * call, with the same body, over and over — a stuck client or a script.
 */
function loopGuard(surface) {
  return async (req, res, next) => {
    try {
      if (req.method === 'GET' && /\/(session|me|pricing)$/.test(req.path)) return next();   // harmless polling
      const who = req.get('authorization') ? crypto.createHash('sha1').update(req.get('authorization')).digest('hex').slice(0, 12) : req.ip;
      const bodyHash = crypto.createHash('sha1').update(JSON.stringify(req.body || {})).digest('hex').slice(0, 12);
      const limit = await settings.num('loop_limit_same_call_30s', 15);
      const n = hit(`${surface}:loop:${who}:${req.method}:${req.path}:${bodyHash}`, 30 * 1000);
      if (n > limit) {
        await record('loop', req, { surface, detail: { method: req.method, path: req.path, times_in_30s: n } });
        return res.status(429).json({ error: 'slow_down', message: 'The same request is being repeated. Please wait a moment.' });
      }
      return next();
    } catch (e) {
      console.error('[security] loop:', e.message);
      return next();
    }
  };
}

/**
 * Called by the vehicle check: many DIFFERENT vehicles from one account or one
 * address in an hour is how scraping looks. Returns { ok } — the caller answers.
 */
async function noteVehicleCheck(req, regNo) {
  const perUser = await settings.num('scrape_distinct_vehicles_per_hour_user', 40);
  const perIp = await settings.num('scrape_distinct_vehicles_per_hour_ip', 60);
  const hour = 60 * 60 * 1000;
  const u = req.user?.id ? distinctCount(`veh:user:${req.user.id}`, regNo, hour) : 0;
  const i = distinctCount(`veh:ip:${req.ip}`, regNo, hour);
  if (u > perUser || i > perIp) {
    await record('scraping', req, { surface: 'site', severity: 'high',
      detail: { distinct_vehicles_last_hour_account: u, distinct_vehicles_last_hour_ip: i, limit_account: perUser, limit_ip: perIp, last: regNo } });
    if (i > perIp) await blockIp(req);
    return { ok: false };
  }
  return { ok: true };
}

module.exports = { gate, loopGuard, noteVehicleCheck, record, BOT_UA };
