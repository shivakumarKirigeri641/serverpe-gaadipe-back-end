/**
 * src/admin/dataRequests.js — "delete my data" (user, 2026-10-03; DPDP Act 2023).
 *
 * A customer writes "delete my data" on WhatsApp → a request here, a reply
 * saying it is received, and the admin told. The admin opens Data requests and
 * presses Delete personal data, which in one transaction:
 *
 *   ERASES   name, email and WhatsApp name; every chat message's text; feedback
 *            text; contact-form messages; website visits linked to them;
 *            sessions, sign-in IPs and devices; the vehicles they checked;
 *            monitoring; owner claims; the waiting list; one-time codes
 *   KEEPS    payments, GST invoices and the record of which reports were
 *            bought (tax law: eight years), their recorded consent, and the
 *            mobile number — so the deletion itself, a STOP, and a refund
 *            question can still be honoured. Messages from GaadiPe stop.
 *
 * What was erased is counted in `erased`, and the admin's action is audited.
 */

const db = require('../db');

const mask = (m) => (m ? `••••••${String(m).slice(-4)}` : null);
const ERASED = '[deleted at the customer’s request]';

/** A new request (from WhatsApp). One open request per number. */
async function request({ mobile, userId, said, channel = 'whatsapp' }) {
  const row = await db.one(
    `INSERT INTO data_requests (user_id, mobile, said, channel) VALUES ($1, $2, $3, $4)
     ON CONFLICT (mobile) WHERE status = 'pending' DO NOTHING RETURNING id`,
    [userId || null, mobile, said ? String(said).slice(0, 300) : null, channel]);
  if (row) {
    await require('../util/adminPing').ping({
      key: `data_request_${row.id}`, severity: 'warning', source: 'customers',
      title: '🗑 Data deletion request',
      text: `${mask(mobile)} asked for their personal data to be deleted. Open Data requests in the panel to do it.`,
    }).catch(() => {});
  }
  return { created: Boolean(row) };
}

async function list({ status = null } = {}) {
  const { rows } = await db.query(
    `SELECT d.*, coalesce(u.display_name, u.wa_profile_name) AS name, a.name AS done_by_name,
            (SELECT count(*)::int FROM payments p WHERE p.user_id = d.user_id AND p.status = 'paid') AS payments
       FROM data_requests d
       LEFT JOIN users u ON u.id = d.user_id
       LEFT JOIN admin_users a ON a.id = d.done_by
      WHERE ($1::text IS NULL OR d.status = $1)
      ORDER BY (d.status = 'pending') DESC, d.created_at DESC LIMIT 300`, [status || null]);
  return { rows: rows.map((r) => ({ ...r, id: String(r.id), user_id: r.user_id ? String(r.user_id) : null, masked: mask(r.mobile), mobile: undefined })) };
}

/** Do it: erase the person's personal data, keep what the law requires. */
async function erase({ id, adminId, ip }) {
  const req = await db.one(`SELECT * FROM data_requests WHERE id = $1`, [id]);
  if (!req) return { ok: false, message: 'No such request.' };
  if (req.status !== 'pending') return { ok: false, message: 'This request is already closed.' };
  const m = req.mobile;
  const u = await db.one(`SELECT id FROM users WHERE mobile = $1`, [m]);
  const uid = u?.id || req.user_id || null;
  const counts = {};
  await db.tx(async (c) => {
    const run = async (label, sql, args) => {
      const r = await c.query(sql, args).catch((e) => { throw new Error(`${label}: ${e.message}`); });
      counts[label] = (counts[label] || 0) + (r.rowCount || 0);
    };
    await run('profile', `UPDATE users SET name = NULL, email = NULL, wa_profile_name = NULL, display_name = NULL, email_token = NULL,
                            erased_at = now(), modified_at = now() WHERE mobile = $1`, [m]);
    await run('messages', `UPDATE whatsapp_messages SET body = $2, payload = '{}'::jsonb WHERE mobile = $1`, [m, ERASED]);
    await run('chat', `UPDATE whatsapp_sessions SET profile_name = NULL, context = '{}'::jsonb, attribution = '{}'::jsonb,
                         wa_opt_out_at = coalesce(wa_opt_out_at, now()), modified_at = now() WHERE mobile = $1`, [m]);
    await run('feedback', `UPDATE feedback SET body = $2, name = NULL, public_name = NULL, public_text = NULL, approved_at = NULL
                            WHERE mobile = $1 OR ($3::bigint IS NOT NULL AND user_id = $3)`, [m, ERASED, uid]);
    await run('contact', `UPDATE contact_messages SET name = $2, email = NULL, message = $2, ip = NULL, user_agent = NULL
                           WHERE mobile = $1 OR ($3::bigint IS NOT NULL AND user_id = $3)`, [m, ERASED, uid]);
    await run('website', `UPDATE visitors SET mobile = NULL, user_id = NULL, device = '{}'::jsonb, place = '{}'::jsonb
                           WHERE mobile = $1 OR ($2::bigint IS NOT NULL AND user_id = $2)`, [m, uid]);
    await run('events', `UPDATE events SET mobile = NULL WHERE mobile = $1`, [m]);
    await run('journal', `UPDATE event_log SET detail = detail - 'said' - 'name' - 'mobile'
                           WHERE detail->>'mobile' = $1 OR ($2::bigint IS NOT NULL AND user_id = $2)`, [m, uid]);
    await run('waiting list', `DELETE FROM lookup_waitlist WHERE mobile = $1`, [m]);
    await run('owner claims', `DELETE FROM vehicle_owner_claims WHERE mobile = $1`, [m]);
    await run('codes', `DELETE FROM otp_challenges WHERE mobile = $1`, [m]);
    await run('codes', `DELETE FROM site_otps WHERE mobile = $1`, [m]);
    await run('support links', `DELETE FROM support_tokens WHERE mobile = $1`, [m]);
    await run('report devices', `UPDATE vehicle_reports SET ip = NULL, user_agent = NULL WHERE requested_by = $1 OR ($2::bigint IS NOT NULL AND user_id = $2)`, [m, uid]);
    await run('security log', `UPDATE security_events SET ip = NULL, user_agent = NULL WHERE mobile = $1 OR ($2::bigint IS NOT NULL AND user_id = $2)`, [m, uid]);
    await run('sign-ins', `UPDATE site_sign_ins SET ip = NULL, user_agent = NULL WHERE mobile = $1 OR ($2::bigint IS NOT NULL AND user_id = $2)`, [m, uid]);
    if (uid) {
      await run('website sessions', `DELETE FROM site_sessions WHERE user_id = $1`, [uid]);
      await run('website activity', `DELETE FROM site_activity WHERE user_id = $1`, [uid]);
      await run('vehicles checked', `DELETE FROM user_vehicles WHERE user_id = $1`, [uid]);
      await run('monitoring', `UPDATE watches SET is_active = false, modified_at = now() WHERE user_id = $1 AND is_active`, [uid]);
    }
    await c.query(
      `UPDATE data_requests SET status = 'done', done_at = now(), done_by = $2, erased = $3 WHERE id = $1`,
      [id, adminId || null, JSON.stringify(counts)]);
  });
  await require('./auth').audit({ adminId, action: 'data_erased', ip, detail: { request: String(id), mobile: mask(m), erased: counts } });
  // Told on WhatsApp if their window is open (a reply, not a template).
  try {
    const send = require('../whatsapp/send');
    if (await send.windowOpen(m)) await send.text(m, '✅ Done — your personal data has been deleted from GaadiPe. Payment records and GST invoices are kept as the law requires. GaadiPe will not message you. 🙏');
  } catch { /* nothing to tell them through */ }
  return { ok: true, erased: counts };
}

async function reject({ id, adminId, ip, note }) {
  const r = await db.one(
    `UPDATE data_requests SET status = 'rejected', done_at = now(), done_by = $2, note = $3 WHERE id = $1 AND status = 'pending' RETURNING mobile`,
    [id, adminId || null, note ? String(note).slice(0, 300) : null]);
  if (!r) return { ok: false, message: 'This request is already closed.' };
  await require('./auth').audit({ adminId, action: 'data_request_rejected', ip, detail: { request: String(id), mobile: mask(r.mobile), note } });
  return { ok: true };
}

module.exports = { request, list, erase, reject };
