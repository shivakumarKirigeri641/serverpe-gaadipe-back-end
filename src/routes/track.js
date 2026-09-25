/**
 * src/routes/track.js — website events for the command center (user, 2026-09-25).
 * ---------------------------------------------------------------------------
 *   POST /serverpe/platform/gaadipe/v1/public/users/t
 *        { visitor_id, session_id, event_id, name, page, referrer, landing,
 *          utm: { source, medium, campaign, term, content }, label }
 *
 * The site is WhatsApp-only and signs nobody in, so without this the back end
 * cannot see a single visitor: where they came from, what they read, whether
 * they tapped through to WhatsApp. Google Analytics sees it; the command
 * center must too, and must be able to follow the same person into the chat.
 *
 * PUBLIC ON PURPOSE, SO NARROW ON PURPOSE:
 *   - only the event names below are accepted; anything else is ignored
 *   - bots and headless browsers are ignored
 *   - a per-visitor and per-address rate limit
 *   - no raw IP stored: a salted hash, and the city-level place
 *   - never an error back to the page — a tracker must not break a site
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const crypto = require('crypto');
const track = require('../events/track');
const device = require('../site/device');

const router = express.Router();

const NAMES = new Set(['page_view', 'session_started', 'whatsapp_cta_clicked', 'cta_clicked']);
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|headless|lighthouse|preview|curl|wget|python|axios|node-fetch/i;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// A few events a second is a person; hundreds is something else.
const WINDOW_MS = 60 * 1000;
const PER_KEY = 120;
const hits = new Map();
function limited(key) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.at > WINDOW_MS) { hits.set(key, { at: now, n: 1 }); return false; }
  h.n += 1;
  return h.n > PER_KEY;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (now - h.at > WINDOW_MS) hits.delete(k);
}, WINDOW_MS).unref();

const SALT = process.env.EVENT_HASH_SALT || process.env.WHATSAPP_APP_SECRET || 'gaadipe-events';
const ipHash = (ip) => crypto.createHash('sha256').update(`${SALT}:${ip}`).digest('hex').slice(0, 32);
const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));

router.post('/t', express.json({ limit: '4kb' }), async (req, res) => {
  // Answered first, always 204: the page never waits on, or learns from, this.
  res.sendStatus(204);
  try {
    const b = req.body || {};
    const ua = req.get('user-agent') || '';
    if (!NAMES.has(b.name) || BOT_UA.test(ua)) return;
    if (!ID_RE.test(String(b.visitor_id || '')) || !ID_RE.test(String(b.event_id || ''))) return;
    const ipKey = ipHash(req.ip);
    if (limited(`v:${b.visitor_id}`) || limited(`i:${ipKey}`)) return;

    const utm = typeof b.utm === 'object' && b.utm ? b.utm : {};
    const touch = (b.name === 'session_started' || b.name === 'page_view')
      ? track.touchOf({ utm, referrer: clip(b.referrer, 500), landing: clip(b.landing || b.page, 200) })
      : {};
    // A page view without UTM from our own pages is not a new touch.
    const newTouch = Object.keys(utm).length || (touch.referrer && b.name === 'session_started');
    const ua2 = device.parseUA(ua);
    const where = device.locate(req.ip);

    const v = await track.touchVisitor({
      visitorId: b.visitor_id,
      touch: newTouch || b.name === 'session_started' ? touch : {},
      device: { device_type: ua2.device_type, os: ua2.os, browser: ua2.browser },
      place: { country: where.country, region: where.region, city: where.city },
    });

    // A plain page view carries the visit's source forward; only a new touch
    // (UTM, or the session's external referrer) sets its own.
    const src = newTouch ? touch.source : (v?.last_touch?.source || v?.first_touch?.source || touch.source || null);
    const isNew = await track.emit({
      key: `web:${b.visitor_id}:${b.event_id}`,
      name: b.name,
      channel: 'web',
      visitorId: b.visitor_id,
      sessionId: ID_RE.test(String(b.session_id || '')) ? b.session_id : null,
      source: src,
      campaign: (newTouch && touch.campaign) || v?.last_touch?.campaign || v?.first_touch?.campaign || null,
      page: clip(b.page, 300),
      meta: {
        label: clip(b.label, 80) || undefined,
        utm: Object.keys(utm).length ? {
          source: clip(utm.source, 60), medium: clip(utm.medium, 60), campaign: clip(utm.campaign, 120),
          term: clip(utm.term, 120), content: clip(utm.content, 120),
        } : undefined,
        referrer: touch.referrer || undefined,
        device: [ua2.device_type, ua2.os, ua2.browser].filter(Boolean).join(' · ') || undefined,
        place: device.placeOf(where) || undefined,
        ip_hash: ipKey,
      },
    });
    // Counted only when the event is new, so a resent event counts once.
    if (isNew && (b.name === 'page_view' || b.name === 'whatsapp_cta_clicked')) {
      await track.countVisitor(b.visitor_id, b.name === 'page_view' ? 'page_views' : 'wa_clicks');
    }
  } catch (e) {
    console.error('[track] %s', e.message);
  }
});

module.exports = router;
