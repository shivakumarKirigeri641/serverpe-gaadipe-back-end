/**
 * src/mail/emailCode.js — confirming an email address with a 4-digit code
 * (user, 2026-10-07; 4 digits since 2026-10-10). Ten minutes, five tries.
 *
 * One place for the website (/me/email/code, /me/email/verify) and the WhatsApp
 * menu's "Email for alerts" (2026-10-12), so both confirm an address the same way.
 * Off the production server the code is not emailed but written to the server's
 * log, so testing never mails anyone.
 */

const crypto = require('crypto');
const db = require('../db');

const hashOf = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/** Email a fresh code. { ok, sent_to, dev? } or { ok: false, status, error, message, suggestion? }. */
async function sendCode(userId, rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const chk = await require('./customer').checkEmail(email);
  if (!chk.ok) return { ok: false, status: 400, error: chk.error, message: chk.message, suggestion: chk.suggestion || null };
  const recent = await db.one(`SELECT 1 FROM email_codes WHERE user_id = $1 AND created_at > now() - interval '45 seconds'`, [userId]);
  if (recent) return { ok: false, status: 429, error: 'wait', message: 'A code was just sent. Please wait a moment before asking again.' };
  const code = String(crypto.randomInt(1000, 10000));
  await db.query(`INSERT INTO email_codes (user_id, email, code_hash, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [userId, email, hashOf(code)]);
  if (String(process.env.NODE_ENV).toLowerCase() !== 'production') {
    console.warn('[email-code] DEV (not emailed): %s gets %s', email, code);
    return { ok: true, sent_to: email, dev: true };
  }
  const T = require('./templates');
  const mail = T.layout({ tagline: 'Confirm your email', badge: { text: 'Your code', tone: 'info' }, title: `${code} is your GaadiPe email code`,
    lead: 'Type this code in GaadiPe to confirm your email address. It is valid for 10 minutes. If you did not ask for it, you can ignore this email.',
    footer: 'You are receiving this because someone entered this address in GaadiPe.' });
  const sent = await require('./mailer').send({ to: email, subject: `${code} is your GaadiPe email code`, html: mail.html, text: mail.text });
  if (!sent.ok) return { ok: false, status: 502, error: 'send_failed', message: 'We could not send the code just now. Please try again in a minute.' };
  console.log('[email-code] sent to user %s', userId);
  return { ok: true, sent_to: email };
}

/** Check a code; on success the address is the user's, confirmed. { ok, user } or { ok: false, error, message }. */
async function verifyCode(userId, rawEmail, rawCode) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const row = await db.one(`SELECT * FROM email_codes WHERE user_id = $1 AND email = $2 AND consumed_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1`, [userId, email]);
  if (!row) return { ok: false, error: 'code_expired', message: 'That code has expired. Please ask for a new one.' };
  if (row.attempts >= 5) return { ok: false, error: 'too_many', message: 'Too many wrong codes. Please ask for a new one.' };
  if (hashOf(String(rawCode || '').replace(/\D/g, '')) !== row.code_hash) {
    await db.query(`UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return { ok: false, error: 'wrong_code', message: `That code is not right. ${Math.max(0, 4 - row.attempts)} attempt(s) left.` };
  }
  await db.query(`UPDATE email_codes SET consumed_at = now() WHERE id = $1`, [row.id]);
  const { rows } = await db.query(
    `UPDATE users SET email = $2, email_verified_at = now(), email_unsubscribed_at = NULL,
            email_token = coalesce(email_token, $3), modified_at = now()
      WHERE id = $1 RETURNING *`, [userId, email, crypto.randomBytes(24).toString('hex')]);
  console.log('[email-code] verified for user %s', userId);
  return { ok: true, user: rows[0] };
}

module.exports = { sendCode, verifyCode };
