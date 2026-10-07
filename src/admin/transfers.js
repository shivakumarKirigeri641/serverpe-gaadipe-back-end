/**
 * src/admin/transfers.js — A CUSTOMER'S NEW MOBILE NUMBER (user, 2026-10-07).
 *
 * When a customer changes their number they are signed in on the new one; the
 * old number's vehicles and reports stay with it unless they ask for a
 * transfer. The admin decides here:
 *
 *   approve   the old account's vehicles, reports, alerts (watches) and running
 *             subscriptions move to the new account; payments and invoices stay
 *             where they were made — they are records of who paid
 *   reject    nothing moves
 *
 * Either way the customer is emailed the decision (on the production server
 * only — off it the email is written to the log, so testing mails nobody).
 */

const db = require('../db');

async function list({ status = 'pending' } = {}) {
  const { rows } = await db.query(
    `SELECT t.*, fu.display_name AS from_name, tu.display_name AS to_name, a.name AS admin_name,
            (SELECT count(*) FROM user_vehicles WHERE user_id = t.from_user_id) AS vehicles,
            (SELECT count(*) FROM vehicle_reports WHERE user_id = t.from_user_id) AS reports
       FROM account_transfers t JOIN users fu ON fu.id = t.from_user_id JOIN users tu ON tu.id = t.to_user_id
       LEFT JOIN admin_users a ON a.id = t.admin_id
      WHERE ($1 = 'all' OR t.status = $1) ORDER BY t.id DESC LIMIT 200`, [['pending', 'approved', 'rejected', 'all'].includes(status) ? status : 'pending']);
  return { rows: rows.map((r) => ({ ...r, id: String(r.id), from_user_id: String(r.from_user_id), to_user_id: String(r.to_user_id),
    vehicles: Number(r.vehicles) || 0, reports: Number(r.reports) || 0 })) };
}

async function tell(t, approved, adminNote) {
  const u = await db.one(`SELECT email, email_verified_at, display_name FROM users WHERE id = $1`, [t.to_user_id])
    || await db.one(`SELECT email, email_verified_at, display_name FROM users WHERE id = $1`, [t.from_user_id]);
  const to = u?.email;
  if (!to) return { emailed: false, why: 'no email' };
  const T = require('../mail/templates');
  const name = String(u.display_name || '').split(' ')[0] || 'there';
  const mail = T.layout({
    tagline: 'Your GaadiPe account', badge: { text: approved ? 'Transfer approved' : 'Transfer not approved', tone: approved ? 'good' : 'watch' },
    title: approved ? 'Your vehicles and reports are on your new number' : 'We could not move your vehicles and reports',
    lead: approved
      ? `Hi ${name}, your vehicles, reports and alerts from ${t.from_mobile} are now on ${t.to_mobile}. Open GaadiPe to see them.`
      : `Hi ${name}, your request to move your vehicles and reports from ${t.from_mobile} to ${t.to_mobile} was not approved.${adminNote ? ` ${adminNote}` : ''} Write to support@gaadipe.in if you have any question.`,
    cta: { label: 'Open GaadiPe', url: `${require('../mail/customer').SITE()}/chat` },
    footer: 'You are receiving this because you asked GaadiPe to move your account to a new mobile number.',
  });
  const subject = approved ? 'Your GaadiPe account moved to your new number' : 'About your GaadiPe transfer request';
  if (String(process.env.NODE_ENV).toLowerCase() !== 'production') {
    console.warn('[transfers] DEV (not emailed): would tell %s — %s', to, subject);
    return { emailed: false, why: 'not the production server' };
  }
  const out = await require('../mail/mailer').send({ to, subject, html: mail.html, text: mail.text });
  return { emailed: out.ok, why: out.ok ? null : out.error };
}

async function decide(id, { approve, note = '', adminId }) {
  const t = await db.one(`SELECT * FROM account_transfers WHERE id = $1`, [id]);
  if (!t) return { ok: false, message: 'No such request.' };
  if (t.status !== 'pending') return { ok: false, message: `Already ${t.status}.` };
  let moved = null;
  if (approve) {
    moved = await db.tx(async (c) => {
      const v = await c.query(
        `INSERT INTO user_vehicles (user_id, vehicle_id, relation, label, check_count, first_checked_at, last_checked_at)
         SELECT $2, vehicle_id, relation, label, check_count, first_checked_at, last_checked_at FROM user_vehicles WHERE user_id = $1
         ON CONFLICT DO NOTHING`, [t.from_user_id, t.to_user_id]);
      await c.query(`DELETE FROM user_vehicles WHERE user_id = $1`, [t.from_user_id]);
      const r = await c.query(`UPDATE vehicle_reports SET user_id = $2 WHERE user_id = $1`, [t.from_user_id, t.to_user_id]);
      const w = await c.query(`UPDATE watches SET user_id = $2, modified_at = now() WHERE user_id = $1`, [t.from_user_id, t.to_user_id]);
      const s = await c.query(`UPDATE subscriptions SET user_id = $2 WHERE user_id = $1 AND is_active`, [t.from_user_id, t.to_user_id]).catch(() => ({ rowCount: 0 }));
      return { vehicles: v.rowCount, reports: r.rowCount, watches: w.rowCount, subscriptions: s.rowCount };
    });
  }
  await db.query(`UPDATE account_transfers SET status = $2, admin_id = $3, admin_note = $4, moved = $5, decided_at = now() WHERE id = $1`,
    [id, approve ? 'approved' : 'rejected', adminId, String(note || '').slice(0, 500) || null, moved ? JSON.stringify(moved) : null]);
  const mail = await tell(t, approve, note).catch((e) => ({ emailed: false, why: e.message }));
  console.log('[transfers] request %s %s by admin %s%s', id, approve ? 'approved' : 'rejected', adminId, moved ? ` — moved ${JSON.stringify(moved)}` : '');
  return { ok: true, status: approve ? 'approved' : 'rejected', moved, mail };
}

module.exports = { list, decide };
