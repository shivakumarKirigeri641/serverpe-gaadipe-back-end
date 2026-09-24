/**
 * src/support/tickets.js — support, from the chat to a ticket number
 * (user, 2026-09-23).
 *
 * WHY A LINK AND NOT A CONVERSATION. Collecting a query type, a message, a
 * name and an email through WhatsApp buttons takes six round trips and loses
 * people at every one. A form takes one screen. So the bot sends a link, the
 * form collects everything at once, and the reply comes back to the chat.
 *
 * NOBODY SIGNS IN. The link carries a one-time token that identifies the
 * customer, so the form already knows who they are — they have, after all,
 * just proved it by messaging from their own number. The token expires
 * (support_link_hours, 48), is single-purpose and identifies nobody by itself:
 * it is looked up, never decoded.
 *
 * THE TICKET NUMBER is what makes "I wrote to you last week" answerable. It
 * comes from document_counters, the same gapless mechanism as report and
 * invoice numbers, so two people writing in the same second cannot collide.
 */

const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');

const SITE = () => (process.env.PUBLIC_SITE_URL || 'https://gaadipe.in').replace(/\/+$/, '');

/** GP-TKT-000123 — gapless, and issued only when a ticket is really created. */
async function nextTicketNumber() {
  const row = await db.one(
    `INSERT INTO document_counters (key, next_value) VALUES ('ticket', 2)
     ON CONFLICT (key) DO UPDATE SET next_value = document_counters.next_value + 1,
                                     modified_at = now()
     RETURNING next_value`);
  // The row returns the value AFTER incrementing, so the first ticket is 1.
  const n = Number(row.next_value) - 1;
  return `GP-TKT-${String(n).padStart(6, '0')}`;
}

/**
 * A link that opens the support form already knowing who is writing.
 *
 * A fresh token each time rather than one per customer: a link forwarded to a
 * friend should stop working, and a link that never changes eventually does
 * get forwarded.
 */
async function linkFor({ userId, mobile, regNo = null }) {
  const hours = await settings.num('support_link_hours', 48);
  const token = crypto.randomBytes(24).toString('hex');
  await db.query(
    `INSERT INTO support_tokens (token, user_id, mobile, reg_no, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)`,
    [token, userId || null, mobile, regNo, String(hours)]);
  return { token, url: `${SITE()}/support/${token}`, hours };
}

/**
 * Who a token belongs to, or null if it is unknown, spent or too old.
 *
 * SPENT COUNTS. Opening the form does not spend a token — somebody
 * interrupted mid-sentence must be able to come back and finish — but sending
 * one does, and after that the link is dead. Without this check a link
 * forwarded to a friend would open tickets for ever in someone else's name.
 */
async function whoIs(token) {
  const row = await db.one(
    `SELECT t.*, u.display_name, u.email
       FROM support_tokens t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.token = $1 AND t.expires_at > now() AND t.used_at IS NULL`, [String(token || '')]);
  if (!row) return null;
  return {
    mobile: row.mobile,
    reg_no: row.reg_no,
    user_id: row.user_id ? String(row.user_id) : null,
    name: row.display_name || null,
    email: row.email || null,
  };
}

/**
 * Record what they wrote.
 *
 * The token is spent here, not when the page opened: someone who opens the
 * form, is interrupted and comes back an hour later should still be able to
 * send it.
 */
async function create({ token, subject, message, name, email, regNo }) {
  const who = await whoIs(token);
  if (!who) return { ok: false, error: 'link_expired' };

  const body = String(message || '').trim();
  if (body.length < 10) {
    return { ok: false, error: 'too_short',
             message: 'Please tell us a little more — at least a sentence.' };
  }

  const ticket = await nextTicketNumber();
  const row = await db.one(
    `INSERT INTO contact_messages
       (name, mobile, email, subject, message, reg_no, user_id, ticket_no, channel, status, support_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'whatsapp', 'open', $9)
     RETURNING id, ticket_no, created_at`,
    [String(name || who.name || '').slice(0, 80) || null,
     who.mobile,
     String(email || who.email || '').slice(0, 160) || null,
     String(subject || 'Support').slice(0, 120),
     body.slice(0, 4000),
     String(regNo || who.reg_no || '').toUpperCase().slice(0, 12) || null,
     who.user_id, ticket, token]);

  await db.query(`UPDATE support_tokens SET used_at = now() WHERE token = $1`, [token]);
  console.log('[support] %s opened by %s', ticket, who.mobile);
  return { ok: true, ticket_no: row.ticket_no, id: String(row.id) };
}

/**
 * The admin's answer, back to the chat it came from.
 *
 * Outside the 24-hour window a free-form reply will not deliver, so this goes
 * as the approved support template. It is recorded either way: an answer that
 * could not be sent is still an answer the panel must show as given.
 */
async function reply(id, text, adminId) {
  const t = await db.one(
    `SELECT c.*, u.display_name, u.wa_profile_name
       FROM contact_messages c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = $1`, [id]);
  if (!t) return { ok: false, error: 'unknown_ticket' };

  const body = String(text || '').trim().replace(/\s*\n\s*/g, ' · ');
  if (!body) return { ok: false, error: 'empty', message: 'Write a reply first.' };

  await db.query(
    `UPDATE contact_messages
        SET reply_text = $2, replied_at = now(), replied_by = $3, status = 'replied'
      WHERE id = $1`, [id, body.slice(0, 4000), adminId || null]);

  const { config } = require('../config');
  let sent = { ok: false, error: 'whatsapp_off' };
  if (config.whatsapp.enabled && t.mobile) {
    const send = require('../whatsapp/send');
    const name = String(t.display_name || t.wa_profile_name || t.name || '').split(' ')[0] || 'there';
    sent = await send.template(
      t.mobile,
      await settings.get('wa_template_support_reply', 'gp_support_reply_en_v1'),
      [name, t.ticket_no || 'your message', body.slice(0, 900)],
      { language: await settings.get('wa_template_language', 'en') },
    ).catch((e) => ({ ok: false, error: e.message }));
  }
  return { ok: true, delivered: sent.ok, reason: sent.ok ? null : sent.error, ticket_no: t.ticket_no };
}

/** Open tickets, newest first, for the panel. */
async function list({ status = null, q = '', limit = 200 } = {}) {
  const term = String(q || '').trim().toLowerCase();
  const { rows } = await db.query(
    `SELECT c.id, c.ticket_no, c.name, c.mobile, c.email, c.subject, c.message, c.reg_no,
            c.status, c.channel, c.created_at, c.replied_at, c.reply_text,
            a.name AS replied_by_name
       FROM contact_messages c
       LEFT JOIN admin_users a ON a.id = c.replied_by
      WHERE ($1::text IS NULL OR c.status = $1)
        AND ($2 = '' OR lower(coalesce(c.ticket_no, '')) LIKE '%' || $2 || '%'
             OR c.mobile LIKE '%' || $2 || '%'
             OR lower(coalesce(c.message, '')) LIKE '%' || $2 || '%')
      ORDER BY c.id DESC LIMIT $3`, [status, term, Math.min(500, limit)]);
  const totals = await db.one(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
            count(*) FILTER (WHERE status = 'replied')::int AS replied,
            count(*)::int AS total
       FROM contact_messages`);
  return { rows: rows.map((r) => ({ ...r, id: String(r.id) })), totals };
}

module.exports = { nextTicketNumber, linkFor, whoIs, create, reply, list };
