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

async function post(payload, meta) {
  const { mobile, type, body, templateName } = meta;

  if (!wa.token || !wa.phoneNumberId) {
    console.warn('[wa] not configured — would have sent:', body);
    return { ok: false, error: 'not_configured' };
  }

  let res, json;
  try {
    res = await fetch(url(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    await record({ mobile, type, body, templateName, error: e.message, payload });
    console.error('[wa] send failed:', e.message);
    return { ok: false, error: e.message };
  }

  const waMessageId = json?.messages?.[0]?.id || null;
  const error = json?.error ? `${json.error.code}: ${json.error.message}` : null;
  await record({ mobile, type, body, templateName, waMessageId, error, payload });

  if (error) {
    console.error('[wa] out %s rejected: %s', mobile, error);
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

module.exports = { text, buttons, list, document, template, windowOpen, toWaId };
