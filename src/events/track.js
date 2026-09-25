/**
 * src/events/track.js — the one writer for the `events` stream (user, 2026-09-25).
 * ---------------------------------------------------------------------------
 * The command center counts, compares and replays customers from `events`.
 * Everything that happens — a page view, a WhatsApp message, a lookup, a
 * payment — is written here, by the code that already handles it.
 *
 * Two rules:
 *
 *   IDEMPOTENT. Every event has a key taken from what caused it ("wa_msg:<wamid>",
 *   "pay_ok:<payment id>", a browser's own event id). ON CONFLICT DO NOTHING:
 *   a retried webhook or a refreshed page records nothing twice.
 *
 *   NEVER IN THE WAY. emit() never throws and never makes a customer wait on a
 *   failure: tracking that breaks a reply or a payment is worse than none.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');
const db = require('../db');

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const local10 = (m) => {
  const d = String(m || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? d : null;
};

/**
 * Record one event. Returns true if it was new, false if it was already there
 * (or could not be written — the reason is logged, never raised).
 */
async function emit(e) {
  if (!e?.key || !e?.name) return false;
  try {
    const { rowCount } = await db.query(
      `INSERT INTO events (event_key, occurred_at, name, channel, visitor_id, session_id, user_id, mobile,
                           reg_no, payment_id, source, campaign, page, status, error_code, duration_ms,
                           amount_paise, metadata)
       VALUES ($1, coalesce($2, now()), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (event_key) DO NOTHING`,
      [clip(e.key, 200), e.at || null, clip(e.name, 60), e.channel || 'system',
       clip(e.visitorId, 64), clip(e.sessionId, 64), e.userId || null, local10(e.mobile),
       clip(e.regNo, 20), e.paymentId || null, clip(e.source, 60), clip(e.campaign, 120),
       clip(e.page, 300), clip(e.status, 20), clip(e.errorCode, 60),
       Number.isFinite(e.durationMs) ? Math.round(e.durationMs) : null,
       Number.isFinite(e.amountPaise) ? Math.round(e.amountPaise) : null,
       JSON.stringify(e.meta || {})]);
    return rowCount > 0;
  } catch (err) {
    console.error('[events] %s not recorded: %s', e.name, err.message);
    return false;
  }
}

/** Fire and forget — for call sites that must not even await the insert. */
const fire = (e) => { emit(e).catch(() => {}); };

/* ───────────────────────────── website visitors ───────────────────────── */

/*
 * THE WHATSAPP CODE. A wa.me link can carry only visible text, so the link from
 * a website visitor's browser ends "Hi #K7Q2M". Five characters from an
 * alphabet without look-alikes (no 0/O, 1/I/L), derived from the visitor id so
 * the browser can build the link before any server round trip.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function codeFor(visitorId) {
  const h = crypto.createHash('sha256').update(String(visitorId)).digest();
  let out = '';
  for (let i = 0; i < 5; i++) out += CODE_ALPHABET[h[i] % CODE_ALPHABET.length];
  return out;
}
const CODE_RE = /#([2-9A-HJKMNP-Z]{5})\b/;

/**
 * Upsert a visitor from a website event. The first touch is written once and
 * never overwritten; the last touch follows each visit that brings a source.
 */
async function touchVisitor({ visitorId, touch = {}, device = {}, place = {} }) {
  if (!visitorId) return null;
  const hasTouch = Object.values(touch).some(Boolean);
  try {
    return await db.one(
      `INSERT INTO visitors (visitor_id, wa_code, first_touch, last_touch, device, place, page_views, wa_clicks)
       VALUES ($1, $2, $3, $3, $4, $5, 0, 0)
       ON CONFLICT (visitor_id) DO UPDATE SET
         last_seen_at = now(),
         last_touch   = CASE WHEN $6 THEN EXCLUDED.last_touch ELSE visitors.last_touch END,
         device       = CASE WHEN visitors.device = '{}'::jsonb THEN EXCLUDED.device ELSE visitors.device END,
         place        = CASE WHEN visitors.place  = '{}'::jsonb THEN EXCLUDED.place  ELSE visitors.place  END
       RETURNING visitor_id, wa_code, first_touch, last_touch, user_id`,
      [clip(visitorId, 64), codeFor(visitorId), JSON.stringify(touch), JSON.stringify(device),
       JSON.stringify(place), hasTouch]);
  } catch (err) {
    console.error('[events] visitor %s: %s', visitorId, err.message);
    return null;
  }
}

/** One more page view or WhatsApp click — called only for a NEW event. */
async function countVisitor(visitorId, column) {
  if (column !== 'page_views' && column !== 'wa_clicks') return;
  await db.query(`UPDATE visitors SET ${column} = ${column} + 1 WHERE visitor_id = $1`, [visitorId]).catch(() => {});
}

/**
 * A WhatsApp message carried a visitor's code: tie the chat, the customer and
 * the browser together, once. Returns the visitor, or null if the code is
 * unknown.
 */
async function linkByCode(code, { mobile, userId }) {
  const v = await db.one(
    `UPDATE visitors
        SET mobile = coalesce(mobile, $2), user_id = coalesce(user_id, $3),
            linked_at = coalesce(linked_at, now())
      WHERE visitor_id = (SELECT visitor_id FROM visitors WHERE wa_code = $1
                           ORDER BY last_seen_at DESC LIMIT 1)
      RETURNING visitor_id, first_touch, last_touch`,
    [code, local10(mobile), userId || null]).catch(() => null);
  if (!v) return null;
  await db.query(
    `UPDATE whatsapp_sessions
        SET visitor_id = coalesce(visitor_id, $2),
            attribution = CASE WHEN attribution = '{}'::jsonb
                               THEN jsonb_build_object('channel', 'website', 'first_touch', $3::jsonb, 'last_touch', $4::jsonb)
                               ELSE attribution END
      WHERE mobile = $1`,
    [local10(mobile), v.visitor_id, JSON.stringify(v.first_touch || {}), JSON.stringify(v.last_touch || {})])
    .catch(() => {});
  return v;
}

/**
 * Where a website visit came from, from its URL and referrer: the UTM tags
 * when present, otherwise a best reading of the referrer.
 */
function touchOf({ utm = {}, referrer = '', landing = '' }) {
  const src = String(utm.source || '').toLowerCase();
  const med = String(utm.medium || '').toLowerCase();
  let host = '';
  try { host = referrer ? new URL(referrer).hostname.replace(/^www\./, '') : ''; } catch { /* not a URL */ }
  const ownSite = /(^|\.)gaadipe\.in$/.test(host);

  let source;
  if (src) {
    source = /google/.test(src) && /(cpc|ppc|paid|ads)/.test(med) ? 'google_ads'
      : /(facebook|instagram|meta|fb|ig)/.test(src) ? (/(cpc|paid|ads)/.test(med) ? 'meta_ads' : 'social')
      : /whatsapp|^wa$/.test(src) ? 'whatsapp'
      : src;
  } else if (!host || ownSite) source = 'direct';
  else if (/google\./.test(host)) source = 'google';
  else if (/(bing|duckduckgo|yahoo)\./.test(host)) source = 'organic';
  else if (/(facebook|instagram|t\.co|twitter|x\.com|linkedin|youtube)/.test(host)) source = 'social';
  else if (/whatsapp|wa\.me/.test(host)) source = 'whatsapp';
  else source = 'referral';

  return {
    source,
    medium: clip(utm.medium, 60) || null,
    campaign: clip(utm.campaign, 120) || null,
    term: clip(utm.term, 120) || null,
    content: clip(utm.content, 120) || null,
    referrer: ownSite ? null : clip(host, 120) || null,
    landing: clip(landing, 200) || null,
  };
}

module.exports = { emit, fire, codeFor, CODE_RE, touchVisitor, countVisitor, linkByCode, touchOf, local10 };
