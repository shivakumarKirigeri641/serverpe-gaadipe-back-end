/**
 * src/site/auth.js — customers signing in to gaadipe.in.
 *
 * THE MOBILE NUMBER IS THE ACCOUNT. Somebody who checked a vehicle on WhatsApp
 * and then opens the site must find their own vehicles, reports and invoices
 * there — so signing in creates nothing except proof that they hold the number
 * we already know them by.
 *
 * WHAT THIS SCREEN IS ON THE OPEN INTERNET, and therefore what it defends
 * against:
 *   * discovery — the answer to "send me a code" is the same for every number,
 *     so it cannot be used to find out who is a customer
 *   * cost — codes are rate-limited per number, because every SMS is money and
 *     an unlimited send button is money somebody else can spend
 *   * guessing — codes are six digits, short-lived, hashed, and attempts are
 *     counted on the row so another browser does not reset them
 *   * blocked people — a number GaadiPe has blocked cannot sign in at all
 */

const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');
const sms = require('../util/sms');
const blocks = require('../admin/blocks');
const { config } = require('../config');

const localMobile = (m) => String(m || '').replace(/\D/g, '').slice(-10);
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

/** The same answer for every number, whoever asked. */
const SAME_ANSWER = {
  ok: true,
  message: 'If that number can be reached, a code has been sent to it.',
};

/**
 * THE TESTING GUARD, shared with WhatsApp.
 *
 * While WHATSAPP_ALLOWED_RECEPIENTS is set, the site signs in ONLY those
 * numbers. Without this, any number typed into the login box creates a real
 * customer row with real vehicles and payments against it — test rubbish that
 * then has to be picked out of the database by hand. Empty list means everyone,
 * which is what production runs.
 */
const allowedForTesting = (m) => !config.whatsapp.allowedRecipients.length
  || config.whatsapp.allowedRecipients.includes(m);

async function requestCode({ mobile, ip }) {
  const m = localMobile(mobile);
  if (m.length !== 10) {
    return { ok: false, error: 'bad_mobile', message: 'Please enter a ten-digit mobile number.' };
  }

  if (!allowedForTesting(m)) {
    // Answered exactly like any other number, so the guard does not tell a
    // stranger which numbers are special.
    console.warn('[site] sign-in requested by %s — not in WHATSAPP_ALLOWED_RECEPIENTS', m);
    return SAME_ANSWER;
  }

  // Rate limit before anything else: this is the only thing standing between a
  // public button and an SMS bill.
  const perHour = await settings.num('site_otp_per_hour', 5);
  const resend = await settings.num('site_otp_resend_seconds', 60);
  const recent = await db.one(
    `SELECT count(*)::int AS n,
            max(created_at) AS last_at
       FROM site_otps
      WHERE mobile = $1 AND created_at > now() - interval '1 hour'`, [m]);

  if (recent.n >= perHour) {
    return { ok: false, error: 'too_many',
      message: 'Too many codes requested for that number. Please try again later.' };
  }
  if (recent.last_at && Date.now() - new Date(recent.last_at).getTime() < resend * 1000) {
    const wait = Math.ceil((resend * 1000 - (Date.now() - new Date(recent.last_at).getTime())) / 1000);
    return { ok: false, error: 'wait', retryAfter: wait,
      message: `A code was just sent. Please wait ${wait} seconds before asking for another.` };
  }

  // A blocked number is answered exactly like any other, and no code is made.
  if (await blocks.isBlocked('mobile', m)) {
    console.warn('[site] sign-in requested by blocked number %s', m);
    return SAME_ANSWER;
  }

  const minutes = await settings.num('site_otp_minutes', 10);
  const fixed = config.site.devOtp;
  const code = fixed || String(crypto.randomInt(100000, 1000000));

  await db.query(
    `INSERT INTO site_otps (mobile, code_hash, expires_at, ip)
          VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4)`,
    [m, sha256(code), String(minutes), ip || null]);

  if (fixed) {
    console.warn('[site] DEV SIGN-IN: %s may sign in with the fixed code %s', m, fixed);
  } else {
    await sms.send(m,
      `${code} is your GaadiPe login code. It is valid for ${minutes} minutes. `
      + 'Do not share it with anyone.',
      { variables: { code, minutes: String(minutes) } });
  }

  return SAME_ANSWER;
}

/**
 * Check a code and open a session.
 *
 * A customer row is created here if there is none: somebody may reach the site
 * before they ever message WhatsApp, and being new is not an error.
 */
async function verifyCode({ mobile, code, ip, userAgent }) {
  const m = localMobile(mobile);

  if (!allowedForTesting(m)) {
    return { ok: false, error: 'not_allowed',
      message: 'GaadiPe is in testing and is open to a few numbers only.' };
  }

  const row = await db.one(
    `SELECT * FROM site_otps
      WHERE mobile = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY id DESC LIMIT 1`, [m]);

  if (!row) {
    return { ok: false, error: 'bad_code',
      message: 'That code has expired. Please ask for a new one.' };
  }

  const maxAttempts = await settings.num('site_otp_attempts', 5);
  if (row.attempts >= maxAttempts) {
    return { ok: false, error: 'too_many', message: 'Too many wrong codes. Please ask for a new one.' };
  }

  const given = sha256(String(code || '').replace(/\D/g, ''));
  const a = Buffer.from(given);
  const b = Buffer.from(row.code_hash);
  const good = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!good) {
    await db.query(`UPDATE site_otps SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    const left = Math.max(0, maxAttempts - (row.attempts + 1));
    return { ok: false, error: 'bad_code',
      message: left ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`
                    : 'Too many wrong codes. Please ask for a new one.' };
  }

  if (await blocks.isBlocked('mobile', m)) {
    return { ok: false, error: 'blocked',
      message: 'This number cannot be used. Please write to support@gaadipe.in.' };
  }

  await db.query(`UPDATE site_otps SET consumed_at = now() WHERE id = $1`, [row.id]);

  const store = require('../vehicle/store');
  const user = await store.upsertUser(m);

  // Signing in is itself a withdrawal of a deactivation: the person is back.
  if (user.deactivated_at) {
    await db.query(
      `UPDATE users SET deactivated_at = NULL, deactivated_reason = NULL,
              is_paused = false, modified_at = now() WHERE id = $1`, [user.id]);
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO site_sessions (user_id, token_hash, ip, user_agent) VALUES ($1,$2,$3,$4)`,
    [user.id, sha256(token), ip || null, userAgent || null]);

  await db.query(
    `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'site_sign_in', $2)`,
    [user.id, JSON.stringify({ mobile: m, ip: ip || null, user_agent: userAgent || null })]);

  return { ok: true, token, user: publicUser({ ...user, deactivated_at: null }) };
}

const publicUser = (u) => ({
  id: String(u.id),
  mobile: u.mobile,
  name: u.display_name || u.wa_profile_name || null,
  email: u.email || null,
  joined_at: u.created_at,
});

/** Resolve a token. Sessions are long — this is a customer's own phone. */
async function sessionFor(token) {
  if (!token) return null;
  const days = await settings.num('site_session_days', 30);
  const row = await db.one(
    `SELECT s.id, s.last_used_at, u.*
       FROM site_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.ended_at IS NULL`, [sha256(token)]);

  if (!row || row.deactivated_at) return null;
  if (Date.now() - new Date(row.last_used_at).getTime() > days * 24 * 60 * 60 * 1000) {
    await db.query(`UPDATE site_sessions SET ended_at = now() WHERE id = $1`, [row.id]);
    return null;
  }
  if (await blocks.isBlocked('mobile', row.mobile)) return null;

  await db.query(`UPDATE site_sessions SET last_used_at = now() WHERE id = $1`, [row.id]);
  return { sessionId: row.id, id: String(row.id), userId: String(row.user_id || row.id), user: row };
}

async function signOut(token) {
  const s = await sessionFor(token);
  if (!s) return;
  await db.query(`UPDATE site_sessions SET ended_at = now() WHERE id = $1`, [s.sessionId]);
}

/**
 * Withdraw consent from the site.
 *
 * Everything the customer can see stops: monitoring, alerts, and this session.
 * Invoices are NOT removed — they are statutory records of money that changed
 * hands, and keeping them is a legal obligation rather than a choice. The
 * message back says so plainly rather than implying a clean erasure.
 */
async function deactivate(userId, { reason } = {}) {
  await db.tx(async (c) => {
    await c.query(
      `UPDATE users SET deactivated_at = now(), deactivated_reason = $2,
              is_paused = true, modified_at = now() WHERE id = $1`, [userId, reason || null]);
    await c.query(`UPDATE watches SET is_active = false, modified_at = now() WHERE user_id = $1`, [userId]);
    await c.query(`UPDATE site_sessions SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL`, [userId]);
    await c.query(
      `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'account_deactivated', $2)`,
      [userId, JSON.stringify({ reason: reason || null, at: new Date().toISOString() })]);
  });
  return { ok: true };
}

module.exports = { requestCode, verifyCode, sessionFor, signOut, deactivate, publicUser, localMobile };
