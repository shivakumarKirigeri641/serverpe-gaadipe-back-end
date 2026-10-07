/**
 * src/admin/webControls.js — WHAT AN ADMIN CAN DO TO A VISIT OR A CUSTOMER
 * (user, 2026-10-07; spec §40, §70–71, §86–90, §97–98, §107, §113–114).
 * Every function returns what it changed, and the route writes it to the audit
 * log with the admin, the reason and the state before and after. Nothing here
 * can read a password, a sign-in code or a payment credential — none is stored.
 *
 *   endVisit(sessionId)              the visit is TERMINATED: its browser's sign-in
 *                                    ends now, and the page signs out on its next
 *                                    heartbeat (≤ 20 s)
 *   signOut(userId, { deviceKey })   one browser's sign-in, or all of them
 *   setMonitoring(scope, ref, off)   optional interaction telemetry for a visit,
 *                                    a customer, a browser, or everywhere
 *   flag / unflag                    an admin's marker on a customer
 *   resendConfirmation(userId)       the email confirmation link again
 *   exportCustomer(userId)           everything about a customer, as one JSON
 *   monitoringState()                for the header and the settings screen
 */

const db = require('../db');
const settings = require('../util/settings');
const presence = require('../site/presence');

const n = (v) => Number(v) || 0;

async function endVisit(sessionId) {
  const w = await db.one(`SELECT session_id, user_id, device_key, ended_at, end_reason FROM web_sessions WHERE session_id = $1`, [sessionId]);
  if (!w) return { ok: false, message: 'No such visit.' };
  await db.query(`UPDATE web_sessions SET ended_at = now(), end_reason = 'terminated' WHERE session_id = $1`, [sessionId]);
  let signIns = 0;
  if (w.user_id && w.device_key) {
    const r = await db.query(`UPDATE site_sessions SET ended_at = now(), ended_reason = 'admin_terminated'
                               WHERE user_id = $1 AND device_id = $2 AND ended_at IS NULL`, [w.user_id, w.device_key]);
    signIns = r.rowCount;
  }
  return { ok: true, before: { ended_at: w.ended_at, end_reason: w.end_reason }, after: { end_reason: 'terminated' }, sign_ins_ended: signIns, user_id: w.user_id ? String(w.user_id) : null };
}

async function signOut(userId, { deviceKey = null } = {}) {
  const uid = String(userId).replace(/\D/g, '');
  const r = deviceKey
    ? await db.query(`UPDATE site_sessions SET ended_at = now(), ended_reason = 'admin_signed_out' WHERE user_id = $1 AND device_id = $2 AND ended_at IS NULL`, [uid, deviceKey])
    : await db.query(`UPDATE site_sessions SET ended_at = now(), ended_reason = 'admin_signed_out' WHERE user_id = $1 AND ended_at IS NULL`, [uid]);
  // Their open pages sign out at once too (the heartbeat says "end").
  const w = deviceKey
    ? await db.query(`UPDATE web_sessions SET ended_at = now(), end_reason = 'terminated' WHERE user_id = $1 AND device_key = $2 AND ended_at IS NULL AND last_seen_at > now() - interval '10 minutes'`, [uid, deviceKey])
    : await db.query(`UPDATE web_sessions SET ended_at = now(), end_reason = 'terminated' WHERE user_id = $1 AND ended_at IS NULL AND last_seen_at > now() - interval '10 minutes'`, [uid]);
  return { ok: true, sign_ins_ended: r.rowCount, open_pages_ended: w.rowCount };
}

async function setMonitoring({ scope, ref = '', off, reason = '', adminId }) {
  if (!['session', 'customer', 'device', 'global'].includes(scope)) return { ok: false, message: 'Unknown scope.' };
  if (scope === 'global') {
    const before = String(await settings.get('web_monitoring', 'on'));
    await db.query(`UPDATE app_settings SET value = $1, modified_at = now() WHERE key = 'web_monitoring'`, [off ? 'off' : 'on']);
    settings.refresh(); presence.clearControls();
    return { ok: true, before: { web_monitoring: before }, after: { web_monitoring: off ? 'off' : 'on' } };
  }
  const open = await db.one(`SELECT id FROM monitoring_controls WHERE scope = $1 AND ref = $2 AND lifted_at IS NULL`, [scope, String(ref)]);
  if (off && !open) await db.query(`INSERT INTO monitoring_controls (scope, ref, disabled, reason, admin_id) VALUES ($1, $2, true, $3, $4)`, [scope, String(ref), String(reason).slice(0, 300), adminId]);
  if (!off && open) await db.query(`UPDATE monitoring_controls SET lifted_at = now(), lifted_by = $2 WHERE id = $1`, [open.id, adminId]);
  presence.clearControls();
  return { ok: true, before: { monitoring: open ? 'off' : 'on' }, after: { monitoring: off ? 'off' : 'on' } };
}

async function monitoringState({ sessionId = null, userId = null, visitorId = null } = {}) {
  const global = String(await settings.get('web_monitoring', 'on')).toLowerCase();
  const { rows } = await db.query(
    `SELECT c.id, c.scope, c.ref, c.reason, c.created_at, a.name AS admin FROM monitoring_controls c LEFT JOIN admin_users a ON a.id = c.admin_id
      WHERE c.lifted_at IS NULL AND c.disabled ORDER BY c.id DESC LIMIT 200`);
  const off = sessionId || userId || visitorId ? await presence.monitoringOff({ sessionId, visitorId, userId }) : null;
  return { global, scroll: String(await settings.get('web_track_scroll', 'on')).toLowerCase(), controls: rows.map((r) => ({ ...r, id: String(r.id) })),
    target: sessionId || userId || visitorId ? { off: Boolean(off), by: off } : null };
}

const FLAGS = ['follow_up', 'vip', 'suspicious', 'support_only', 'other'];
async function flag(userId, { flag: f, reason = '', adminId }) {
  if (!FLAGS.includes(f)) return { ok: false, message: 'Unknown flag.' };
  const r = await db.one(`INSERT INTO customer_flags (user_id, flag, reason, admin_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [String(userId).replace(/\D/g, ''), f, String(reason).slice(0, 300), adminId]);
  return { ok: true, id: String(r.id) };
}
async function unflag(flagId, adminId) {
  const r = await db.query(`UPDATE customer_flags SET cleared_at = now(), cleared_by = $2 WHERE id = $1 AND cleared_at IS NULL`, [flagId, adminId]);
  return { ok: r.rowCount > 0 };
}
async function flags(userId) {
  const { rows } = await db.query(
    `SELECT f.id, f.flag, f.reason, f.created_at, a.name AS admin FROM customer_flags f LEFT JOIN admin_users a ON a.id = f.admin_id
      WHERE f.user_id = $1 AND f.cleared_at IS NULL ORDER BY f.id DESC`, [String(userId).replace(/\D/g, '')]);
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

/* The confirmation link again — the customer asked for it, or support is helping them. */
async function resendConfirmation(userId) {
  const u = await db.one(`SELECT email, email_verified_at FROM users WHERE id = $1`, [String(userId).replace(/\D/g, '')]);
  if (!u?.email) return { ok: false, message: 'This customer has no email address yet.' };
  if (u.email_verified_at) return { ok: false, message: 'Their email is already confirmed.' };
  const recent = await db.one(`SELECT 1 FROM customer_emails WHERE user_id = $1 AND kind = 'confirm' AND created_at > now() - interval '2 minutes'`, [userId]);
  if (recent) return { ok: false, message: 'A link was sent less than two minutes ago.' };
  await db.query(`INSERT INTO customer_emails (user_id, kind, to_email) VALUES ($1, 'confirm', $2)`, [userId, u.email]);
  return { ok: true, to: u.email };
}

/* Everything about one customer, for them or for a dispute (spec §47, §106, §114). */
async function exportCustomer(userId) {
  const control = require('./control');
  const c = await control.customer(userId);
  if (!c.customer) return null;
  const sessionsFull = [];
  for (const s of c.sessions.slice(0, 20)) {
    const d = await control.session(s.session_id);
    sessionsFull.push({ session_id: s.session_id, started_at: s.started_at, last_seen_at: s.last_seen_at, status: s.status, source: s.source,
      timeline: d.timeline.map((e) => ({ at: e.at, kind: e.kind, name: e.name, page: e.page, label: e.label, reg_no: e.reg_no, payment_id: e.payment_id, ok: e.ok })) });
  }
  const consents = await db.one(`SELECT quizpe_consent_at, promo_consent_at, email_verified_at, email_unsubscribed_at, deactivated_at FROM users WHERE id = $1`, [userId]);
  return { exported_at: new Date().toISOString(), customer: c.customer, consents, flags: await flags(userId), vehicles: c.vehicles, payments: c.payments,
    reports: c.reports, devices: c.devices, sessions: sessionsFull,
    note: 'Sign-in codes, passwords and payment credentials are never stored by GaadiPe and so are not in this export.' };
}

module.exports = { endVisit, signOut, setMonitoring, monitoringState, flag, unflag, flags, FLAGS, resendConfirmation, exportCustomer };
