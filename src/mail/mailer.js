/**
 * src/mail/mailer.js — the one door for email.
 *
 * Sent from the noreply mailbox (NOREPLYMAIL) over the SMTP server in MAIL_HOST.
 * NEVER THROWS: an email is a courtesy to the admin, and a mail server that is
 * down must never turn into a customer's failed sign-in or payment. The caller
 * gets { ok, error } and decides whether to try again.
 *
 * Who the admin emails go to: the `admin_alert_emails` setting (comma-separated)
 * if set, otherwise ADMINMAIL.
 */

const nodemailer = require('nodemailer');
const settings = require('../util/settings');

let transport = null;
function transporter() {
  if (transport) return transport;
  const host = process.env.MAIL_HOST;
  const user = process.env.NOREPLYMAIL;
  const pass = process.env.NOREPLYMAIL_PASSWORD;
  if (!host || !user || !pass) return null;
  const port = Number(process.env.MAIL_PORT || 465);
  transport = nodemailer.createTransport({
    host, port,
    secure: String(process.env.MAIL_SECURE || (port === 465 ? 'true' : 'false')).toLowerCase() === 'true',
    auth: { user, pass },
    pool: true, maxConnections: 2,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
  return transport;
}

const configured = () => Boolean(process.env.MAIL_HOST && process.env.NOREPLYMAIL && process.env.NOREPLYMAIL_PASSWORD);

async function adminRecipients() {
  const fromSetting = String(await settings.get('admin_alert_emails', '') || '').trim();
  const list = (fromSetting || process.env.ADMINMAIL || '')
    .split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /@/.test(s));
  return [...new Set(list)];
}

/**
 * Send one email. `to` defaults to the admin recipients.
 * @returns {Promise<{ok: boolean, to?: string, id?: string, error?: string}>}
 */
async function send({ to, subject, html, text, attachments = [], replyTo }) {
  const t = transporter();
  if (!t) return { ok: false, error: 'mail is not configured (MAIL_HOST, NOREPLYMAIL, NOREPLYMAIL_PASSWORD)' };
  const recipients = to ? [].concat(to) : await adminRecipients();
  if (!recipients.length) return { ok: false, error: 'no recipient (set ADMINMAIL or admin_alert_emails)' };
  try {
    const info = await t.sendMail({
      from: { name: 'GaadiPe', address: process.env.NOREPLYMAIL },
      to: recipients.join(', '),
      subject,
      html,
      text,
      attachments,
      ...(replyTo ? { replyTo } : {}),
      headers: { 'X-Auto-Response-Suppress': 'All', 'Auto-Submitted': 'auto-generated' },
    });
    return { ok: true, to: recipients.join(', '), id: info.messageId };
  } catch (e) {
    return { ok: false, to: recipients.join(', '), error: e.message };
  }
}

module.exports = { send, configured, adminRecipients };
