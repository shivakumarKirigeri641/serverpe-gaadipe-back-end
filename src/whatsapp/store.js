/**
 * src/whatsapp/store.js
 * ---------------------------------------------------------------------------
 * Write what arrived to the database. Nothing here decides anything or replies.
 *
 * WHY RECORD BEFORE THE BOT EXISTS: the flow is not built yet, but the messages
 * are real from the moment the number is live. Every one of them is a person
 * telling us what they expect the product to do, in their own words — the best
 * evidence there is for designing the flow. Dropping them costs the one thing
 * that cannot be recreated later.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');

/** Meta sends 919886122415; the schema stores the last 10 digits. */
const local10 = (waId) => String(waId || '').replace(/\D/g, '').slice(-10);

/**
 * Find or create the conversation for a mobile. A session may exist long before
 * a user does — someone says "hi" before we know anything about them.
 */
async function upsertSession(mobile, profileName, waId) {
  const { rows } = await db.query(
    `INSERT INTO whatsapp_sessions (mobile, wa_id, profile_name, state, last_inbound_at)
          VALUES ($1, $2, $3, 'new', now())
     ON CONFLICT (mobile) DO UPDATE
            SET last_inbound_at = now(),
                modified_at     = now(),
                is_active       = true,
                -- Keep the name we already had if this payload omits it.
                profile_name    = COALESCE(EXCLUDED.profile_name, whatsapp_sessions.profile_name),
                wa_id           = COALESCE(EXCLUDED.wa_id, whatsapp_sessions.wa_id)
      RETURNING id, user_id, state`,
    [mobile, waId || null, profileName || null]);
  return rows[0];
}

/** The human-readable part of any message type, for reading logs at a glance. */
function bodyOf(m) {
  switch (m.type) {
    case 'text':        return m.text?.body || '';
    case 'button':      return m.button?.text || '';
    case 'interactive': return m.interactive?.button_reply?.title
                            || m.interactive?.list_reply?.title || '';
    case 'location':    return `${m.location?.latitude}, ${m.location?.longitude}`;
    case 'image': case 'document': case 'audio': case 'video':
      return m[m.type]?.caption || `[${m.type}]`;
    default:            return `[${m.type}]`;
  }
}

async function recordInbound(m, contact) {
  const mobile = local10(m.from);
  if (mobile.length !== 10) {
    // The schema enforces 10 digits; an international sender would throw and
    // cost us the whole batch. Note it and move on.
    console.warn('[wa] ignoring non-Indian sender', m.from);
    return null;
  }

  const session = await upsertSession(mobile, contact?.profile?.name, m.from);

  await db.query(
    `INSERT INTO whatsapp_messages
       (session_id, mobile, direction, message_type, body, payload, wa_message_id)
     VALUES ($1, $2, 'in', $3, $4, $5, $6)`,
    [session.id, mobile, m.type || 'unknown', bodyOf(m), JSON.stringify(m), m.id || null]);

  await db.query(
    `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'wa_inbound', $2)`,
    [session.user_id || null,
     JSON.stringify({ mobile, type: m.type, body: bodyOf(m), wa_message_id: m.id })]);

  return { session, mobile, body: bodyOf(m) };
}

/** Delivery receipts: sent -> delivered -> read, or failed. */
async function recordStatus(s) {
  const err = (s.errors || [])[0] || {};
  await db.query(
    `INSERT INTO whatsapp_status_logs
       (wa_message_id, mobile, status, error_code, error_title, raw)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [s.id, local10(s.recipient_id) || null, s.status,
     err.code ? String(err.code) : null, err.title || null, JSON.stringify(s)]);
}

module.exports = { recordInbound, recordStatus, local10 };
