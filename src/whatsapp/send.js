/**
 * src/whatsapp/send.js
 * ---------------------------------------------------------------------------
 * Everything GaadiPe says on WhatsApp goes out through here.
 *
 * One door, for three reasons:
 *
 *  1. Every outbound message is logged to whatsapp_messages before the caller
 *     moves on. When a customer says "I never got the alert", the answer has to
 *     be in the database, not in a log file that rotated away.
 *
 *  2. The 24-hour rule is enforced in one place. Meta allows free-form replies
 *     only within 24 hours of the customer's last message; outside it, a paid
 *     template is the only thing that will send. Scattering that check across
 *     handlers is how a bot ends up silently failing at 2am.
 *
 *  3. A send failure must never take down the request that caused it. Sending
 *     is best-effort and always resolves; the failure is recorded instead.
 * ---------------------------------------------------------------------------
 */

const { config } = require('../config');
const db = require('../db');

const wa = config.whatsapp;
const url = () => `https://graph.facebook.com/${wa.apiVersion}/${wa.phoneNumberId}/messages`;

/** Meta wants 919886122415; we store the last 10 digits. */
const toWaId = (mobile) => `91${String(mobile).replace(/\D/g, '').slice(-10)}`;

/**
 * Is the free-form window still open? Outside it only templates send, so the
 * caller can choose to stay quiet rather than have Meta reject the message.
 */
async function windowOpen(mobile) {
  const row = await db.one(
    `SELECT last_inbound_at FROM whatsapp_sessions WHERE mobile = $1`, [mobile]);
  if (!row?.last_inbound_at) return false;
  return Date.now() - new Date(row.last_inbound_at).getTime() < 24 * 60 * 60 * 1000;
}

/**
 * The block list, asked at the one door every message leaves through. A number
 * blocked in the admin panel must stop receiving alerts immediately, not when
 * someone remembers to check in the job that sends them.
 */
const blocks = require('../admin/blocks');

/** The testing guard from config: an empty list lets everyone through. */
const allowed = (mobile) => !wa.allowedRecipients.length
  || wa.allowedRecipients.includes(String(mobile).replace(/\D/g, '').slice(-10));

/** A full chassis number in a message, or null. 17 characters, at least 2 letters and 5 digits, no stars. */
function unmasked(payload) {
  const text = JSON.stringify(payload || {}).replace(/https?:\/\/[^\s"]+/g, ' ');
  for (const t of text.toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) || []) {
    if ((t.match(/[A-Z]/g) || []).length >= 2 && (t.match(/[0-9]/g) || []).length >= 5) return t;
  }
  return null;
}

/*
 * THE SWITCH (user, 2026-10-09). WhatsApp was disabled by Meta on 6 Oct for
 * "sending spam" and restored on 9 Oct. Sending is now an admin setting —
 * whatsapp_sending_enabled (migration 144, OFF until the owner turns it on in
 * Settings) — so it can be stopped at once without a deploy. Off, nothing
 * leaves for WhatsApp, whatever .env says.
 */
const settings = require('../util/settings');
let offSkips = 0;
async function switchedOff(type, mobile) {
  if (await settings.bool('whatsapp_sending_enabled', false)) return false;
  offSkips += 1;
  if (offSkips === 1 || offSkips % 50 === 0) {
    console.log('[wa] WhatsApp sending is OFF (whatsapp_sending_enabled) — not sending %s to ••%s (%d skipped since start)', type, String(mobile || '').slice(-4), offSkips);
  }
  return true;
}

/*
 * THE BRAKE (user, 2026-10-09, after Meta's template insights showed "Spam rate
 * limit hit" and "Account has been locked"). Meta's own warnings stop us here,
 * at once, without anyone watching:
 *   131048 spam rate limit  → no template (no message we start) for 24 hours —
 *                             whatsapp_templates_paused_until; replies to people
 *                             who write in still go
 *   131031 account locked   → whatsapp_sending_enabled = false: nothing goes
 *                             until the owner turns it back on
 * Both tell the admin. The brake only ever stops sending; it never starts it.
 */
const SPAM_LIMIT = 131048;
const LOCKED = 131031;
const PAUSE_HOURS = 24;

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [key, value]);
  settings.refresh();
}

/** Until when templates are paused, or null. */
async function templatesPausedUntil() {
  const v = String(await settings.get('whatsapp_templates_paused_until', '') || '');
  const until = v ? new Date(v) : null;
  return until && !Number.isNaN(until.getTime()) && until > new Date() ? until : null;
}

async function brake(code, mobile, type) {
  const ping = (p) => require('../util/adminPing').ping({ source: 'whatsapp', ...p }).catch(() => {});
  if (code === LOCKED) {
    if (!(await settings.bool('whatsapp_sending_enabled', false))) return;
    await setSetting('whatsapp_sending_enabled', 'false');
    console.error('[wa] BRAKE: Meta says the account is locked (131031) — WhatsApp sending switched OFF');
    await ping({
      key: 'whatsapp_locked', severity: 'critical',
      title: '🛑 WhatsApp locked — sending switched off',
      text: `Meta refused a ${type} to ••${String(mobile).slice(-4)}: "account has been locked" (131031). `
        + 'Every WhatsApp send is now OFF (whatsapp_sending_enabled = false). Check Business Support Home / WhatsApp Manager, '
        + 'and turn it back on in Settings only once the account shows as fine.',
    });
  } else if (code === SPAM_LIMIT) {
    if (await templatesPausedUntil()) return;
    const until = new Date(Date.now() + PAUSE_HOURS * 3600 * 1000);
    await setSetting('whatsapp_templates_paused_until', until.toISOString());
    console.error('[wa] BRAKE: spam rate limit (131048) — templates paused until %s', until.toISOString());
    await ping({
      key: 'whatsapp_spam_limit', severity: 'critical',
      title: '⚠️ WhatsApp spam limit — templates paused 24 h',
      text: `Meta refused a ${type} to ••${String(mobile).slice(-4)}: "spam rate limit hit" (131048) — too many recent messages were blocked or reported. `
        + `No alert, reminder or broadcast template goes out until ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC; replies to customers who write in still go. `
        + 'Send less, and only to people who asked. To end the pause early, clear whatsapp_templates_paused_until in Settings.',
    });
  }
}

async function post(payload, meta) {
  const { mobile, type, body, templateName } = meta;
  if (await switchedOff(type, mobile)) return { ok: false, error: 'whatsapp_off' };

  // Enforced here, at the one door every message leaves through, so no path —
  // a reply, a watch alert, a payment receipt — can reach a number outside the
  // test list.
  if (!allowed(mobile)) {
    console.warn('[wa] %s not in WHATSAPP_ALLOWED_RECIPIENTS — not sending %s', mobile, type);
    return { ok: false, error: 'recipient_not_allowed' };
  }
  if (await blocks.isBlocked('mobile', mobile)) {
    console.warn('[wa] %s is blocked — not sending %s', mobile, type);
    return { ok: false, error: 'blocked' };
  }

  /*
   * THE PERSONAL-DATA GUARD (user, 2026-10-03: "never show unmasked
   * details"). Every message is read here, at the one door, for what looks
   * like a full chassis number (17 letters and digits, unstarred). One is
   * never sent: the message is stopped and the admin told at once. Links are
   * left out of the reading — a report link's token is not a chassis.
   */
  const leak = unmasked(payload);
  if (leak) {
    console.error('[wa] BLOCKED a message to …%s: it held what looks like a full chassis number', String(mobile).slice(-4));
    await record({ mobile, type, body, templateName, error: 'pii_blocked', payload: { blocked: true } }).catch(() => {});
    require('../util/adminPing').ping({
      key: 'pii_blocked', severity: 'critical', source: 'whatsapp',
      title: '🛑 Message stopped: personal data',
      text: `A ${type} message to ••••${String(mobile).slice(-4)} held what looks like a full chassis number (${leak.slice(0, 1)}•••••••••••••••). It was not sent. Check what produced it.`,
    }).catch(() => {});
    return { ok: false, error: 'pii_blocked' };
  }

  if (!wa.token || !wa.phoneNumberId) {
    console.warn('[wa] not configured — would have sent:', body);
    return { ok: false, error: 'not_configured' };
  }

  let res, json;
  const t0 = Date.now();
  const status = require('../util/providerStatus');
  try {
    res = await fetch(url(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    status.record('whatsapp', { ok: false, ms: Date.now() - t0, error: e.message });
    await record({ mobile, type, body, templateName, error: e.message, payload });
    console.error('[wa] send failed:', e.message);
    return { ok: false, error: e.message };
  }

  const waMessageId = json?.messages?.[0]?.id || null;
  const error = json?.error ? `${json.error.code}: ${json.error.message}` : null;
  // The status strip: Meta itself failing (5xx, token, rate limit, service
  // unavailable) is an outage; one customer's phone refusing a message is not.
  const metaDown = Boolean(json?.error) && (res.status >= 500 || [190, 131000, 131016, 130429, 80007].includes(Number(json.error.code)));
  status.record('whatsapp', { ok: !metaDown, ms: Date.now() - t0, error: metaDown ? error : null });
  await record({ mobile, type, body, templateName, waMessageId, error, payload });

  if (error) {
    console.error('[wa] out %s rejected: %s', mobile, error);
    await brake(Number(json.error.code), mobile, type).catch((e) => console.error('[wa] brake:', e.message));
    return { ok: false, error };
  }
  console.log('[wa] out %s %s %s', mobile, type, JSON.stringify(body || '').slice(0, 60));
  return { ok: true, id: waMessageId };
}

async function record({ mobile, type, body, templateName, waMessageId, error, payload }) {
  try {
    const s = await db.one(`SELECT id FROM whatsapp_sessions WHERE mobile = $1`, [mobile]);
    await db.query(
      `INSERT INTO whatsapp_messages
         (session_id, mobile, direction, message_type, body, payload,
          template_name, wa_message_id, error_message)
       VALUES ($1, $2, 'out', $3, $4, $5, $6, $7, $8)`,
      [s?.id || null, mobile, type, body || null, JSON.stringify(payload),
       templateName || null, waMessageId || null, error || null]);
    if (!error) {
      await db.query(
        `UPDATE whatsapp_sessions SET last_outbound_at = now(), modified_at = now()
          WHERE mobile = $1`, [mobile]);
    }
  } catch (e) {
    // Logging must never be the thing that breaks sending.
    console.error('[wa] could not record outbound:', e.message);
  }
}

/* --------------------------------------------------------------- the API */

async function text(mobile, body) {
  if (!await windowOpen(mobile)) {
    console.warn('[wa] window closed for %s — not sending free-form text', mobile);
    return { ok: false, error: 'window_closed' };
  }
  return post({
    messaging_product: 'whatsapp',
    to: toWaId(mobile),
    type: 'text',
    text: { body, preview_url: false },
  }, { mobile, type: 'text', body });
}

/**
 * Up to three reply buttons. Meta truncates a title past 20 characters without
 * telling you, so it is checked here where it can be seen.
 */
async function buttons(mobile, body, list, { header, footer } = {}) {
  if (list.length > 3) throw new Error('WhatsApp allows at most 3 reply buttons');
  for (const b of list) {
    if (b.title.length > 20) throw new Error(`button title too long (${b.title.length}): ${b.title}`);
  }
  if (!await windowOpen(mobile)) {
    console.warn('[wa] window closed for %s — not sending buttons', mobile);
    return { ok: false, error: 'window_closed' };
  }

  const interactive = {
    type: 'button',
    body: { text: body },
    action: { buttons: list.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
  };
  if (header) interactive.header = { type: 'text', text: header };
  if (footer) interactive.footer = { text: footer };

  return post({
    messaging_product: 'whatsapp',
    to: toWaId(mobile),
    type: 'interactive',
    interactive,
  }, { mobile, type: 'interactive', body });
}

/**
 * A list — WhatsApp's dropdown.
 *
 * Buttons cap out at three; a list holds ten rows, each with a title and a line
 * of description. That is exactly the shape of "which of your vehicles?" for
 * someone who has checked several: no typing, no re-reading a plate off a
 * registration book, and the description can carry the reason to care —
 * "Insurance expired 5 years ago" — without a single API call, because it comes
 * from what we already stored.
 *
 * Meta's limits, enforced here where they can be seen rather than discovered as
 * a rejected message: 24 characters of title, 72 of description, 10 rows, and
 * 20 characters on the button that opens the list.
 */
async function list(mobile, { body, button, rows, header, footer, sectionTitle }) {
  if (!rows.length) throw new Error('a list needs at least one row');
  if (rows.length > 10) throw new Error(`WhatsApp allows at most 10 list rows, got ${rows.length}`);
  if (button.length > 20) throw new Error(`list button too long (${button.length}): ${button}`);

  const trimmed = rows.map(r => ({
    id: r.id,
    title: String(r.title).slice(0, 24),
    description: r.description ? String(r.description).slice(0, 72) : undefined,
  }));

  if (!await windowOpen(mobile)) {
    console.warn('[wa] window closed for %s — not sending list', mobile);
    return { ok: false, error: 'window_closed' };
  }

  const interactive = {
    type: 'list',
    body: { text: body },
    action: { button, sections: [{ title: sectionTitle || 'Vehicles', rows: trimmed }] },
  };
  if (header) interactive.header = { type: 'text', text: header };
  if (footer) interactive.footer = { text: footer };

  return post({
    messaging_product: 'whatsapp',
    to: toWaId(mobile),
    type: 'interactive',
    interactive,
  }, { mobile, type: 'interactive', body });
}

/**
 * Send a file — an invoice PDF, in practice.
 *
 * WhatsApp will not take a URL to a file we host, and will not take raw bytes
 * in the message: the file is uploaded to Meta first, which returns an id, and
 * the message references that id. Two calls, and the upload is multipart rather
 * than JSON, which is why it does not go through post().
 *
 * The id is good for 30 days, so re-sending the same invoice later means
 * uploading it again — cheap, and simpler than storing ids that quietly expire.
 */
async function document(mobile, filePath, { filename, caption } = {}) {
  const fs = require('fs');
  if (await switchedOff('document', mobile)) return { ok: false, error: 'whatsapp_off' };
  // Checked before the upload too, or a blocked send still ships the PDF to Meta.
  if (!allowed(mobile)) {
    console.warn('[wa] %s not in WHATSAPP_ALLOWED_RECIPIENTS — not sending document', mobile);
    return { ok: false, error: 'recipient_not_allowed' };
  }
  if (await blocks.isBlocked('mobile', mobile)) {
    console.warn('[wa] %s is blocked — not sending document', mobile);
    return { ok: false, error: 'blocked' };
  }
  if (!fs.existsSync(filePath)) {
    console.error('[wa] no such file to send:', filePath);
    return { ok: false, error: 'file_missing' };
  }
  if (!await windowOpen(mobile)) {
    console.warn('[wa] window closed for %s — not sending document', mobile);
    return { ok: false, error: 'window_closed' };
  }

  const name = filename || require('path').basename(filePath);

  let mediaId;
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'application/pdf');
    form.append('file',
      new Blob([fs.readFileSync(filePath)], { type: 'application/pdf' }), name);

    const up = await fetch(
      `https://graph.facebook.com/${wa.apiVersion}/${wa.phoneNumberId}/media`,
      { method: 'POST', headers: { Authorization: `Bearer ${wa.token}` }, body: form,
        signal: AbortSignal.timeout(30000) });
    const j = await up.json().catch(() => ({}));
    if (!j.id) {
      console.error('[wa] media upload failed:', JSON.stringify(j.error || j));
      return { ok: false, error: j.error?.message || 'upload_failed' };
    }
    mediaId = j.id;
  } catch (e) {
    console.error('[wa] media upload threw:', e.message);
    return { ok: false, error: e.message };
  }

  return post({
    messaging_product: 'whatsapp',
    to: toWaId(mobile),
    type: 'document',
    document: { id: mediaId, filename: name, caption },
  }, { mobile, type: 'document', body: caption || name });
}

/**
 * An approved template — the only thing that will deliver outside the 24-hour
 * window, which is where every alert lives by definition.
 *
 * @param {string[]} params  body variables, in order. Newlines are stripped:
 *   Meta rejects a parameter containing one (error #132018), and the failure
 *   comes back as a whole-message rejection rather than anything obvious.
 */
async function template(mobile, name, params = [], { language = 'en' } = {}) {
  const clean = params.map(p => String(p ?? '').replace(/\s*\n\s*/g, ' · ').trim());

  // STOP (user, 2026-09-25). The Terms say that after STOP we stop messaging
  // them, other than to reply. A template is how GaadiPe starts a message —
  // broadcast, reminder, alert — so it is refused here, at the one door every
  // one of them leaves through. Replies are not templates and still go.
  if (await optedOut(mobile)) {
    console.log('[wa] %s replied STOP — not sending template %s', mobile, name);
    return { ok: false, error: 'opted_out' };
  }

  // The brake (above post): Meta said "spam rate limit" — no template until the pause ends.
  const paused = await templatesPausedUntil();
  if (paused) {
    console.log('[wa] templates paused until %s (spam limit) — not sending %s to ••%s', paused.toISOString(), name, String(mobile).slice(-4));
    return { ok: false, error: 'templates_paused' };
  }

  /*
   * WHO MAY BE MESSAGED FIRST (user, 2026-10-09, after the spam disable — the
   * promise in the appeal). A template starts a conversation, so here, at the
   * one door every template leaves through:
   *   any template      only someone who agreed to the Terms (WhatsApp's
   *                     "Agree & continue" or the website) — never someone who
   *                     only said Hi
   *   a MARKETING one   also opted in to offers, no marketing to them in the last
   *                     whatsapp_marketing_gap_days (7), under
   *                     whatsapp_marketing_per_day (25) for everyone, and only
   *                     while the number's quality is GREEN
   * The category is Meta's own (read, cached an hour); one not known is treated
   * as marketing.
   */
  const gate = await consentGate(mobile, name);
  if (!gate.ok) {
    console.log('[wa] not sending template %s to ••%s: %s', name, String(mobile).slice(-4), gate.error);
    return { ok: false, error: gate.error };
  }

  return post({
    messaging_product: 'whatsapp',
    to: toWaId(mobile),
    type: 'template',
    template: {
      name,
      language: { code: language },
      components: clean.length
        ? [{ type: 'body', parameters: clean.map(text => ({ type: 'text', text })) }]
        : [],
    },
  }, { mobile, type: 'template', body: `${name}(${clean.join(' | ')})`, templateName: name });
}

/* ───────────────────────────────── the consent gate for templates (2026-10-09) ── */

const ten = (m) => String(m || '').replace(/\D/g, '').slice(-10);

/* Meta's category for each template, read (GET only) and kept an hour. */
let categories = { at: 0, map: new Map() };
async function categoryOf(name) {
  if (Date.now() - categories.at > 60 * 60 * 1000 && wa.token && wa.businessId) {
    try {
      const map = new Map();
      let next = `https://graph.facebook.com/${wa.apiVersion}/${wa.businessId}/message_templates?fields=name,category&limit=200`;
      for (let i = 0; next && i < 10; i += 1) {
        const r = await fetch(next, { headers: { Authorization: `Bearer ${wa.token}` }, signal: AbortSignal.timeout(15000) });
        const j = await r.json().catch(() => ({}));
        if (j.error) break;
        for (const t of j.data || []) map.set(t.name, String(t.category || '').toUpperCase());
        next = j.paging?.next || null;
      }
      if (map.size) categories = { at: Date.now(), map };
    } catch { /* keep the last answer */ }
  }
  if (categories.map.has(name)) return categories.map.get(name);
  const row = await db.one(`SELECT upper(category) AS c FROM wa_templates WHERE template_name = $1`, [name]).catch(() => null);
  return row?.c || 'MARKETING';   // unknown: the strict answer
}

/* The number's quality (GET only), kept ten minutes. */
let quality = { at: 0, value: null };
async function qualityRating() {
  if (Date.now() - quality.at > 10 * 60 * 1000 && wa.token && wa.phoneNumberId) {
    try {
      const r = await fetch(`https://graph.facebook.com/${wa.apiVersion}/${wa.phoneNumberId}?fields=quality_rating`,
        { headers: { Authorization: `Bearer ${wa.token}` }, signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      if (!j.error) quality = { at: Date.now(), value: String(j.quality_rating || '').toUpperCase() };
    } catch { /* keep the last answer */ }
  }
  return quality.value;
}

/** Agreed to the Terms — on WhatsApp or on the website. */
async function agreedTerms(mobile) {
  const row = await db.one(
    `SELECT 1 AS yes FROM event_log
      WHERE kind = 'consent_accepted' AND right(regexp_replace(detail->>'mobile', '\\D', '', 'g'), 10) = $1 LIMIT 1`,
    [ten(mobile)]).catch(() => null);
  return Boolean(row);
}

/** Opted in to tips and offers, and not withdrawn. */
async function optedInToOffers(mobile) {
  const row = await db.one(
    `SELECT 1 AS yes FROM users WHERE right(mobile, 10) = $1
        AND promo_consent_at IS NOT NULL AND promo_consent_withdrawn_at IS NULL LIMIT 1`,
    [ten(mobile)]).catch(() => null);
  return Boolean(row);
}

async function consentGate(mobile, name) {
  if (!(await agreedTerms(mobile))) return { ok: false, error: 'not_agreed' };
  const category = await categoryOf(name);
  if (category !== 'MARKETING') return { ok: true, category };

  if (!(await optedInToOffers(mobile))) return { ok: false, error: 'not_opted_in_to_offers' };
  if ((await qualityRating()) !== 'GREEN') return { ok: false, error: 'quality_not_green' };
  const marketingNames = [...categories.map].filter(([, c]) => c === 'MARKETING').map(([n]) => n);
  const names = marketingNames.length ? marketingNames : [name];
  const gapDays = await settings.num('whatsapp_marketing_gap_days', 7);
  const perDay = await settings.num('whatsapp_marketing_per_day', 25);
  const sent = await db.one(
    `SELECT count(*) FILTER (WHERE right(mobile, 10) = $1 AND created_at > now() - ($3 || ' days')::interval)::int AS to_them,
            count(*) FILTER (WHERE created_at > (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'))::int AS today
       FROM whatsapp_messages
      WHERE direction = 'out' AND error_message IS NULL AND template_name = ANY($2::text[])
        AND created_at > now() - interval '30 days'`,
    [ten(mobile), names, String(gapDays)]);
  if (sent.to_them > 0) return { ok: false, error: 'marketing_gap' };
  if (sent.today >= perDay) return { ok: false, error: 'marketing_daily_cap' };
  return { ok: true, category };
}

/** Replied STOP, and has not replied START since. */
async function optedOut(mobile) {
  const row = await db.one(
    `SELECT 1 AS yes FROM whatsapp_sessions
      WHERE mobile = $1 AND wa_opt_out_at IS NOT NULL LIMIT 1`,
    [String(mobile).replace(/\D/g, '').slice(-10)]).catch(() => null);
  return Boolean(row);
}

module.exports = { _unmasked: unmasked, text, buttons, list, document, template, windowOpen, toWaId, allowed, optedOut,
                   agreedTerms, optedInToOffers, categoryOf, consentGate };
