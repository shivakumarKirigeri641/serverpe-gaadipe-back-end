/**
 * src/security/tunnel.js — the site's and the panel's API, encrypted end to end
 * between the page and this server (user, 2026-09-18).
 *
 * WHAT THE NETWORK TAB SHOWS: a handshake (two public keys), then only
 * `POST …/_x` with ciphertext going in and ciphertext coming out. No paths, no
 * vehicle numbers, no JSON — the real method, path, query and body travel
 * inside the envelope.
 *
 * HOW:
 *   1. Handshake. The page makes a fresh P-256 key pair and sends its public
 *      half. The server makes its own, and both sides derive the same secret
 *      (ECDH) and from it an AES-256-GCM key (HKDF). The key itself never
 *      crosses the network.
 *   2. The server hands back a KEY TOKEN: that AES key and its expiry, sealed
 *      with a key derived from VEHICLE_LOOKUP_KEY. Only this server can open
 *      it, so the session key is recovered on every request without keeping
 *      anything in memory — it survives restarts and works across instances.
 *   3. Every request is { method, path, query, body, time, nonce } sealed with
 *      AES-GCM; every response is sealed the same way. A request older than
 *      five minutes, or one whose nonce has been seen, is refused — a copied
 *      request cannot be replayed.
 *
 * WHY VEHICLE_LOOKUP_KEY IS NOT THE KEY THE PAGE USES: the page runs on the
 * customer's own machine. Anything it holds, anyone can read with F12 — a
 * shared secret in the JavaScript would be public the day it shipped. So the
 * secret stays on the server, and each visit agrees its own key.
 *
 * HTTPS still does the work of keeping the traffic private in transit; this
 * layer is what keeps the traffic unreadable to someone looking over their own
 * browser's shoulder, and useless to copy into a script.
 */

const crypto = require('crypto');
const settings = require('../util/settings');
const { record } = require('./guard');

const KEY_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SKEW_MS = 5 * 60 * 1000;
const INFO = Buffer.from('gaadipe/tunnel/v1');

/* The server's own sealing key, from VEHICLE_LOOKUP_KEY. */
let master = null;
function masterKey() {
  if (master) return master;
  const secret = process.env.VEHICLE_LOOKUP_KEY || process.env.TUNNEL_SECRET || '';
  if (!secret) console.warn('[tunnel] VEHICLE_LOOKUP_KEY is not set — using a per-process key; tokens die on restart');
  master = secret
    ? Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('gaadipe/token-salt'), Buffer.from('token-key'), 32))
    : crypto.randomBytes(32);
  return master;
}

const b64 = (buf) => Buffer.from(buf).toString('base64');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return b64(Buffer.concat([iv, body, c.getAuthTag()]));
}
function open(key, text) {
  const raw = Buffer.from(String(text || ''), 'base64');
  if (raw.length < 29) throw new Error('short');
  const iv = raw.subarray(0, 12); const tag = raw.subarray(raw.length - 16); const body = raw.subarray(12, raw.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
}

/* Key token: { k: session key, e: expiry } sealed with the master key. */
function issueToken(sessionKey) {
  const payload = Buffer.concat([sessionKey, Buffer.from(String(Date.now() + KEY_TTL_MS))]);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const body = Buffer.concat([c.update(payload), c.final()]);
  return b64url(Buffer.concat([iv, body, c.getAuthTag()]));
}
function readToken(token) {
  const raw = Buffer.from(String(token || ''), 'base64url');
  if (raw.length < 12 + 32 + 16) return null;
  try {
    const iv = raw.subarray(0, 12); const tag = raw.subarray(raw.length - 16); const body = raw.subarray(12, raw.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
    d.setAuthTag(tag);
    const payload = Buffer.concat([d.update(body), d.final()]);
    const key = payload.subarray(0, 32);
    const exp = Number(payload.subarray(32).toString());
    return exp > Date.now() ? key : null;
  } catch {
    return null;
  }
}

/* Replay protection: every nonce is accepted once, within the skew window. */
const seen = new Map();
setInterval(() => { const t = Date.now(); for (const [n, x] of seen) if (x < t) seen.delete(n); }, 60 * 1000).unref();

async function required() {
  const v = String(await settings.get('api_encryption_required', 'auto')).toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

/**
 * Express middleware for one API surface, mounted BEFORE its router:
 *   app.use('/site/api', cors, gate('site'), tunnel('site', { exempt }), loopGuard('site'), routes)
 * `exempt(req)` names plain paths still allowed when encryption is required
 * (file downloads, which are PDFs rather than JSON).
 */
function tunnel(surface, { exempt = () => false } = {}) {
  return async (req, res, next) => {
    /* 1 · handshake */
    if (req.method === 'POST' && req.path === '/_hs') {
      try {
        const clientPub = Buffer.from(String(req.body?.pub || ''), 'base64');
        if (clientPub.length !== 65 || clientPub[0] !== 4) throw new Error('bad public key');
        const ecdh = crypto.createECDH('prime256v1');
        ecdh.generateKeys();
        const shared = ecdh.computeSecret(clientPub);
        const serverPub = ecdh.getPublicKey();
        const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([clientPub, serverPub]), INFO, 32));
        // `now` lets the page correct its own clock: a phone set five minutes
        // wrong would otherwise fail the replay check on every request.
        return res.json({ k: issueToken(key), pub: b64(serverPub), ttl: KEY_TTL_MS, now: Date.now() });
      } catch (e) {
        await record('bad_envelope', req, { surface, detail: { stage: 'handshake', error: e.message } });
        return res.status(400).json({ error: 'bad_handshake' });
      }
    }

    /* 2 · an encrypted call */
    if (req.method === 'POST' && req.path === '/_x') {
      const key = readToken(req.get('x-gp-k'));
      if (!key) return res.status(401).json({ error: 'rekey' });      // expired or restarted: the page redoes the handshake
      let env;
      try {
        env = open(key, req.body?.d);
      } catch (e) {
        await record('bad_envelope', req, { surface, detail: { stage: 'decrypt', error: e.message } });
        return res.status(400).json({ error: 'rekey' });
      }
      const skew = Math.abs(Date.now() - Number(env.t || 0));
      const nonceKey = `${String(req.get('x-gp-k')).slice(0, 24)}:${env.n}`;
      if (!env.n || skew > MAX_SKEW_MS || seen.has(nonceKey)) {
        await record('replay', req, { surface, severity: 'high', detail: { skew_ms: skew, nonce_seen: seen.has(nonceKey) } });
        return res.status(400).json({ error: 'rekey' });
      }
      seen.set(nonceKey, Date.now() + MAX_SKEW_MS * 2);

      const method = String(env.m || 'GET').toUpperCase();
      const path = String(env.p || '/');
      if (!/^\/[A-Za-z0-9/_\-.%]*$/.test(path) || path.startsWith('/_')) {
        await record('bad_envelope', req, { surface, detail: { stage: 'path', path: path.slice(0, 100) } });
        return res.status(400).json({ error: 'bad_path' });
      }

      // Rewrite the request so the router sees the real call.
      req.method = method;
      req.url = path;
      req.query = env.q && typeof env.q === 'object' ? env.q : {};
      req.body = env.b && typeof env.b === 'object' ? env.b : {};
      req.tunnelled = true;

      const json = res.json.bind(res);
      res.json = (obj) => json({ d: seal(key, obj) });
      return next();
    }

    /* 3 · a plain call */
    if (await required() && !exempt(req) && req.method !== 'OPTIONS') {
      await record('plain_request', req, { surface, detail: { method: req.method, path: req.path } });
      return res.status(403).json({ error: 'encrypted_only', message: 'Please reload the page.' });
    }
    return next();
  };
}

module.exports = { tunnel, seal, open, issueToken, readToken };
