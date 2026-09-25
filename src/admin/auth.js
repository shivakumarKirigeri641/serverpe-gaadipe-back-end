/**
 * src/admin/auth.js — who may open the admin panel, and a record of what they did.
 *
 * The panel reads every customer's mobile number, their vehicles and their
 * payments, and it can change prices and policy text. So it is not "the site
 * with more menus": it signs a NAMED person in, keeps their session, and writes
 * an audit row for anything that changes data.
 *
 * SIGN-IN IS BY CODE. Every admin is a mobile number we already know, so there
 * is no password to leak, reuse or reset. A code is requested, and the answer is
 * the same whether or not the number belongs to an admin — otherwise this
 * endpoint becomes a way to discover who the admins are.
 *
 * THE DEVELOPMENT CODE. While building, config.admin.devOtp is a fixed code so
 * signing in does not depend on a message arriving. That is a back door by
 * definition, so it is refused outright when NODE_ENV=production — a fixed code
 * on a live panel would hand over every customer's data to anyone who guessed
 * an admin's mobile number.
 */

const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');
const { config } = require('../config');

/** Meta and people write numbers many ways; the table holds ten digits. */
const localMobile = (m) => String(m || '').replace(/\D/g, '').slice(-10);

/** Tokens and codes are stored hashed: a database backup is not a set of keys. */
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

/**
 * What each role may do. Capability names, not role names, are what routes
 * check — "may this person refund?" survives a new role being added, where
 * "is this person finance?" does not.
 */
const ROLES = {
  owner:      ['read', 'money', 'settings', 'block', 'lookup', 'admins', 'pii'],
  admin:      ['read', 'money', 'settings', 'block', 'lookup', 'pii'],
  // Command center phase 7 (user, 2026-09-25): the day-to-day running of the
  // service without the money, and helping customers without changing it.
  operations: ['read', 'settings', 'block', 'lookup', 'pii'],
  finance:    ['read', 'money'],
  support:    ['read', 'lookup', 'pii'],
  viewer:     ['read'],
};
/*
 * 'pii' — may see customers' full mobile numbers. Without it, every mobile the
 * admin API returns is masked (98******15) by the server itself, in screens
 * and in CSV exports alike: Finance and Read-only work with the money and the
 * shape of things, not with who.
 */

const can = (role, capability) => (ROLES[role] || []).includes(capability);

/* ------------------------------------------------------------------ codes */

/**
 * Ask for a sign-in code.
 *
 * Always answers the same way. A real code is only created and delivered when
 * the number belongs to an active admin.
 */
async function requestCode({ mobile, ip }) {
  const m = localMobile(mobile);
  const answer = { ok: true, message: 'If that number can open the panel, a code is on its way.' };
  if (m.length !== 10) return answer;

  const user = await db.one(`SELECT * FROM admin_users WHERE mobile = $1 AND is_active`, [m]);
  if (!user) {
    console.warn('[admin] code requested for %s — not an admin', m);
    return answer;
  }

  const minutes = await settings.num('admin_otp_minutes', 10);
  const fixed = config.admin.devOtp;
  const code = fixed || String(crypto.randomInt(100000, 1000000));

  await db.query(
    `INSERT INTO admin_otps (mobile, code_hash, expires_at)
          VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [m, sha256(code), String(minutes)]);

  if (fixed) {
    // Loud on purpose: a fixed code must never be mistaken for a real one.
    console.warn('[admin] DEV SIGN-IN: %s may sign in with the fixed code %s', m, fixed);
  } else {
    await deliver(m, code, minutes);
  }

  await audit({ adminId: user.id, action: 'code_requested', ip, detail: { method: fixed ? 'fixed' : 'sent' } });
  return answer;
}

/**
 * Get the code to the person.
 *
 * WhatsApp, because the admin number is already in conversation with GaadiPe
 * and it costs nothing inside the 24-hour window. Outside it, a free-form
 * message will not deliver, so the code is logged for the operator to read from
 * the server — a stop-gap that the SMS sender replaces (see docs/TODO).
 */
async function deliver(mobile, code, minutes) {
  const send = require('../whatsapp/send');
  const text = `GaadiPe admin sign-in code: *${code}*\n\nValid for ${minutes} minutes. `
    + 'If you did not ask for this, ignore this message and tell the team.';
  const sent = await send.text(mobile, text);
  if (!sent.ok) {
    console.warn('[admin] could not WhatsApp the code to %s (%s) — code is %s',
      mobile, sent.error, code);
  }
}

/**
 * Check a code and open a session.
 * Every refusal carries a sentence the screen can show as it is.
 */
async function verifyCode({ mobile, code, ip, userAgent }) {
  const m = localMobile(mobile);
  const user = await db.one(`SELECT * FROM admin_users WHERE mobile = $1 AND is_active`, [m]);
  const row = await db.one(
    `SELECT * FROM admin_otps
      WHERE mobile = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY id DESC LIMIT 1`, [m]);

  if (!user || !row) {
    return { ok: false, error: 'bad_code', message: 'That code is not valid. Please ask for a new one.' };
  }

  const maxAttempts = await settings.num('admin_otp_attempts', 5);
  if (row.attempts >= maxAttempts) {
    return { ok: false, error: 'too_many', message: 'Too many wrong codes. Please ask for a new one.' };
  }

  const given = sha256(String(code || '').replace(/\D/g, ''));
  const a = Buffer.from(given);
  const b = Buffer.from(row.code_hash);
  const good = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!good) {
    await db.query(`UPDATE admin_otps SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    const left = Math.max(0, maxAttempts - (row.attempts + 1));
    await audit({ adminId: user.id, action: 'code_wrong', ip, detail: { attempts_left: left } });
    return { ok: false, error: 'bad_code',
      message: left ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`
                    : 'Too many wrong codes. Please ask for a new one.' };
  }

  await db.query(`UPDATE admin_otps SET consumed_at = now() WHERE id = $1`, [row.id]);
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO admin_sessions (admin_id, token_hash, ip, user_agent) VALUES ($1,$2,$3,$4)`,
    [user.id, sha256(token), ip || null, userAgent || null]);
  await db.query(
    `UPDATE admin_users SET last_login_at = now(), modified_at = now() WHERE id = $1`, [user.id]);
  await audit({ adminId: user.id, action: 'sign_in', ip, detail: { user_agent: userAgent || null } });

  return { ok: true, token, user: publicUser(user) };
}

/*
 * SIGN IN WITH THE PASSCODE (user, 2026-09-18): one field, no mobile step. The
 * passcode opens the panel as its owner. It is checked in constant time, wrong
 * tries are counted per IP (five in fifteen minutes and that IP waits), and
 * every attempt, right or wrong, is in the audit trail with the IP it came from.
 * config.admin.passcode is 6416 while building; production needs ADMIN_PASSCODE.
 */
async function signInWithPasscode({ passcode, ip, userAgent }) {
  const expected = config.admin.passcode;
  if (!expected) {
    return { ok: false, error: 'disabled', message: 'Passcode sign-in is not set up on this server.' };
  }

  const tries = await db.one(
    `SELECT count(*)::int AS n FROM admin_audit
      WHERE action = 'passcode_wrong' AND ip IS NOT DISTINCT FROM $1
        AND created_at > now() - interval '15 minutes'`, [ip || null]);
  if (tries.n >= 5) {
    return { ok: false, error: 'too_many', message: 'Too many wrong passcodes. Please wait 15 minutes.' };
  }

  const a = Buffer.from(sha256(String(passcode || '').trim()));
  const b = Buffer.from(sha256(expected));
  const owner = await db.one(
    `SELECT * FROM admin_users WHERE is_active AND role = 'owner' ORDER BY id LIMIT 1`);

  if (!crypto.timingSafeEqual(a, b)) {
    await audit({ adminId: owner?.id || null, action: 'passcode_wrong', ip, detail: { user_agent: userAgent || null } });
    const left = Math.max(0, 4 - tries.n);
    return { ok: false, error: 'bad_passcode',
      message: left ? `That passcode is not right. ${left} attempt${left === 1 ? '' : 's'} left.`
                    : 'Too many wrong passcodes. Please wait 15 minutes.' };
  }
  if (!owner) {
    return { ok: false, error: 'no_owner', message: 'No active owner account exists. Add one with scripts/admin.js.' };
  }
  return openSession(owner, { ip, userAgent, how: 'passcode' });
}

async function openSession(user, { ip, userAgent, how }) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO admin_sessions (admin_id, token_hash, ip, user_agent) VALUES ($1,$2,$3,$4)`,
    [user.id, sha256(token), ip || null, userAgent || null]);
  await db.query(
    `UPDATE admin_users SET last_login_at = now(), modified_at = now() WHERE id = $1`, [user.id]);
  await audit({ adminId: user.id, action: 'sign_in', ip, detail: { user_agent: userAgent || null, how } });
  return { ok: true, token, user: publicUser(user) };
}

/* --------------------------------------------------------------- sessions */

const publicUser =(u) => ({ id: String(u.id), name: u.name, mobile: u.mobile, role: u.role });

/**
 * Resolve a token. Returns null for anything not currently valid, so the caller
 * has one thing to check.
 *
 * Idle sessions end on their own: a panel left open on a desk overnight should
 * not still be signed in to a screen showing customers' numbers.
 */
async function sessionFor(token) {
  if (!token) return null;
  const hours = await settings.num('admin_session_hours', 12);
  const row = await db.one(
    `SELECT s.id, s.admin_id, s.last_used_at, u.name, u.mobile, u.role, u.is_active
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.admin_id
      WHERE s.token_hash = $1 AND s.ended_at IS NULL`, [sha256(token)]);

  if (!row || !row.is_active) return null;
  if (Date.now() - new Date(row.last_used_at).getTime() > hours * 60 * 60 * 1000) {
    await db.query(`UPDATE admin_sessions SET ended_at = now() WHERE id = $1`, [row.id]);
    return null;
  }

  await db.query(`UPDATE admin_sessions SET last_used_at = now() WHERE id = $1`, [row.id]);
  return { sessionId: row.id, id: String(row.admin_id), name: row.name,
           mobile: row.mobile, role: row.role };
}

async function signOut(token, { ip } = {}) {
  const session = await sessionFor(token);
  if (!session) return;
  await db.query(`UPDATE admin_sessions SET ended_at = now() WHERE id = $1`, [session.sessionId]);
  await audit({ adminId: session.id, action: 'sign_out', ip });
}

/* ----------------------------------------------------------------- audit */

/** Never allowed to break the action it is recording. */
async function audit({ adminId, action, detail = {}, ip = null }) {
  try {
    await db.query(
      `INSERT INTO admin_audit (admin_id, action, detail, ip) VALUES ($1,$2,$3,$4)`,
      [adminId || null, action, JSON.stringify(detail), ip]);
  } catch (e) {
    console.error('[admin] audit failed for %s: %s', action, e.message);
  }
}

/* ------------------------------------------------------------ the people */

async function listAdmins() {
  const { rows } = await db.query(
    `SELECT id, mobile, name, role, is_active, last_login_at, created_at
       FROM admin_users ORDER BY created_at`);
  return rows.map(r => ({ ...r, id: String(r.id) }));
}

async function addAdmin({ mobile, name, role = 'admin' }) {
  const m = localMobile(mobile);
  if (m.length !== 10) throw new Error('A ten-digit mobile number is required');
  if (!ROLES[role]) throw new Error(`Unknown role ${role}`);
  const { rows } = await db.query(
    `INSERT INTO admin_users (mobile, name, role) VALUES ($1,$2,$3)
     ON CONFLICT (mobile) DO UPDATE
            SET name = EXCLUDED.name, role = EXCLUDED.role,
                is_active = true, modified_at = now()
      RETURNING *`, [m, name, role]);
  return publicUser(rows[0]);
}

async function setAdminActive(id, isActive) {
  const { rows } = await db.query(
    `UPDATE admin_users SET is_active = $2, modified_at = now() WHERE id = $1 RETURNING *`,
    [id, Boolean(isActive)]);
  if (!rows[0]) return null;
  // Signing someone out is part of switching them off; leaving their session
  // alive would mean "disabled" did nothing until they closed the tab.
  if (!isActive) await db.query(`UPDATE admin_sessions SET ended_at = now() WHERE admin_id = $1 AND ended_at IS NULL`, [id]);
  return publicUser(rows[0]);
}

module.exports = {
  signInWithPasscode,
  requestCode, verifyCode, sessionFor, signOut, audit,
  listAdmins, addAdmin, setAdminActive,
  can, ROLES, localMobile,
};
