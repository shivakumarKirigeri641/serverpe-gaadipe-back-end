/**
 * src/admin/engage.js — TWO MORE HOT-LEADS LISTS (user, 2026-10-16):
 *
 *   1. EMAIL NOT CONFIRMED — WhatsApp customers who agreed and have no confirmed email.
 *        inside 24 h   a free WhatsApp reply with the "Email for alerts" button (Reply many)
 *        outside 24 h  the confirmation email again — only to those who gave an address
 *   2. FEEDBACK FROM PAID CUSTOMERS — paid at least a day ago, never gave feedback.
 *        inside 24 h   a free WhatsApp reply with the 😊 / 🙂 / 😞 buttons (Reply many)
 *        outside 24 h  a short email with three one-tap ratings — confirmed email only
 *
 * No WhatsApp template anywhere: inside the window it is a reply, outside it is email. Never
 * twice in a row: a confirmation email at most every 3 days, a feedback ask at most every 14
 * days (on any channel). STOP, blocked, internal and deactivated people are never listed.
 */

const db = require('../db');
const { agreedSql } = require('./consented');

const AGREED = agreedSql('u.mobile', { whatsappOnly: true });
const BASE = `
  FROM users u
  LEFT JOIN whatsapp_sessions ws ON ws.mobile = u.mobile
 WHERE NOT coalesce(u.is_internal, false) AND u.deactivated_at IS NULL AND u.mobile IS NOT NULL
   AND ${AGREED}
   AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.kind = 'mobile' AND b.value = u.mobile AND b.released_at IS NULL)`;
const OPEN = `(ws.last_inbound_at > now() - interval '24 hours')`;
const PAID = `p.status = 'paid' AND p.amount_paise > 0 AND (p.raw->>'test_mode') IS NULL`;

/* a.b@gmail.com -> a••@gmail.com: enough to recognise, not to copy. */
const maskEmail = (e) => {
  const [n, d] = String(e || '').split('@');
  return d ? `${n.slice(0, 1)}••@${d}` : null;
};

async function list() {
  const [email, feedback] = await Promise.all([
    db.query(
      `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name, ws.profile_name) AS name,
              u.email, ws.last_inbound_at, ${OPEN} AS open,
              (SELECT max(ce.created_at) FROM customer_emails ce WHERE ce.user_id = u.id AND ce.kind = 'confirm') AS last_confirm_mail,
              EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND ${PAID}) AS paid
       ${BASE} AND u.email_verified_at IS NULL
        ORDER BY ws.last_inbound_at DESC NULLS LAST LIMIT 1000`),
    db.query(
      `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name, ws.profile_name) AS name,
              u.email, (u.email_verified_at IS NOT NULL AND u.email_unsubscribed_at IS NULL) AS email_ok,
              ws.last_inbound_at, ${OPEN} AS open, lp.paid_at, lp.reg_no,
              (SELECT max(a.created_at) FROM event_log a WHERE a.user_id = u.id AND a.kind = 'feedback_ask') AS last_asked
       FROM users u
       LEFT JOIN whatsapp_sessions ws ON ws.mobile = u.mobile
       JOIN LATERAL (SELECT p.paid_at, (SELECT r.reg_no FROM vehicle_reports r WHERE r.payment_id = p.id LIMIT 1) AS reg_no
                       FROM payments p WHERE p.user_id = u.id AND ${PAID} ORDER BY p.paid_at DESC LIMIT 1) lp ON true
      WHERE NOT coalesce(u.is_internal, false) AND u.deactivated_at IS NULL AND ${AGREED}
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.kind = 'mobile' AND b.value = u.mobile AND b.released_at IS NULL)
        AND lp.paid_at < now() - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.user_id = u.id OR (f.mobile IS NOT NULL AND right(f.mobile, 10) = right(u.mobile, 10)))
      ORDER BY lp.paid_at DESC LIMIT 1000`),
  ]);
  const ago = (t, days) => t && Date.now() - new Date(t) < days * 86400e3;
  const emailRows = email.rows.map((r) => ({
    user_id: String(r.id), mobile: r.mobile, name: r.name, last_inbound_at: r.last_inbound_at, open: r.open, paid: r.paid,
    email: maskEmail(r.email), has_address: Boolean(r.email), last_mail: r.last_confirm_mail,
    // Outside the window only an address can be reached, and not again within 3 days.
    can_email: Boolean(r.email) && !ago(r.last_confirm_mail, 3),
  }));
  const fbRows = feedback.rows.map((r) => ({
    user_id: String(r.id), mobile: r.mobile, name: r.name, last_inbound_at: r.last_inbound_at, open: r.open,
    email: r.email_ok ? maskEmail(r.email) : null, email_ok: r.email_ok, paid_at: r.paid_at, reg_no: r.reg_no, last_asked: r.last_asked,
    asked_recently: ago(r.last_asked, 14),
    can_email: r.email_ok && !ago(r.last_asked, 14),
  }));
  return {
    email: { inside: emailRows.filter((r) => r.open), outside: emailRows.filter((r) => !r.open) },
    feedback: { inside: fbRows.filter((r) => r.open), outside: fbRows.filter((r) => !r.open) },
  };
}

/** The confirmation email again, to the chosen people outside their window who gave an address. */
async function sendConfirmEmails(userIds) {
  const ids = [...new Set((userIds || []).map(String).filter((x) => /^\d+$/.test(x)))].slice(0, 200);
  const { rows } = await db.query(
    `SELECT u.id, u.email FROM users u
      WHERE u.id = ANY($1::bigint[]) AND u.email IS NOT NULL AND u.email_verified_at IS NULL AND u.deactivated_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM customer_emails ce WHERE ce.user_id = u.id AND ce.kind = 'confirm'
                          AND ce.created_at > now() - interval '3 days')`, [ids]);
  for (const r of rows) {
    // The customer-email job sends it on its next tick (jobs/customerMail.js confirmations).
    await db.query(`INSERT INTO customer_emails (user_id, kind, to_email) VALUES ($1, 'confirm', $2)`, [r.id, r.email]);
  }
  return { queued: rows.length, skipped: ids.length - rows.length };
}

/** The feedback email, to the chosen paid customers outside their window with a confirmed email. */
async function sendFeedbackEmails(userIds, adminId) {
  const C = require('../mail/customer');
  const ids = [...new Set((userIds || []).map(String).filter((x) => /^\d+$/.test(x)))].slice(0, 200);
  const { rows } = await db.query(
    `SELECT u.id, u.mobile, u.email, u.email_token, coalesce(u.display_name, u.wa_profile_name) AS display_name,
            (SELECT r.reg_no FROM payments p JOIN vehicle_reports r ON r.payment_id = p.id
              WHERE p.user_id = u.id AND ${PAID} ORDER BY p.paid_at DESC LIMIT 1) AS reg_no
       FROM users u
      WHERE u.id = ANY($1::bigint[]) AND u.email_verified_at IS NOT NULL AND u.email_unsubscribed_at IS NULL
        AND u.deactivated_at IS NULL AND u.email_token IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM event_log a WHERE a.user_id = u.id AND a.kind = 'feedback_ask' AND a.created_at > now() - interval '14 days')
        AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.user_id = u.id)`, [ids]);
  let sent = 0; let failed = 0;
  for (const r of rows) {
    // Recorded first, so a slow send can never make it go twice.
    await db.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'feedback_ask', $2)`,
      [r.id, JSON.stringify({ mobile: r.mobile, channel: 'email', reg_no: r.reg_no, admin_id: adminId || null })]);
    const out = await C.deliver(r.email, C.feedbackMail(r, { regNo: r.reg_no }), r.email_token).catch((e) => ({ ok: false, error: e.message }));
    if (out.ok) sent += 1; else failed += 1;
  }
  return { sent, failed, skipped: ids.length - rows.length };
}

module.exports = { list, sendConfirmEmails, sendFeedbackEmails };
