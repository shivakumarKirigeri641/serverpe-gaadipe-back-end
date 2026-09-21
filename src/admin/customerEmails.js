/**
 * src/admin/customerEmails.js — the admin writes to customers (user, 2026-09-21).
 *
 * Audiences: one customer (by mobile), everyone, paying customers, customers
 * without a running report, and referral-programme members. Whoever the
 * audience, only CONFIRMED and SUBSCRIBED addresses of open accounts are
 * mailed. Emails are queued (customer_emails, kind 'announcement') and sent by
 * the customer-mail job a few a minute; test mode holds back every address but
 * the owner's. Also: the log of every customer email, and a test send.
 */

const db = require('../db');
const settings = require('../util/settings');
const C = require('../mail/customer');
const mailer = require('../mail/mailer');

const MAILABLE = `u.email IS NOT NULL AND u.email_verified_at IS NOT NULL
  AND u.email_unsubscribed_at IS NULL AND u.deactivated_at IS NULL`;
const PAYING = `EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.is_active AND s.ends_on >= CURRENT_DATE)`;

const AUDIENCES = {
  one: 'One customer (by mobile)',
  all: 'Everyone with a confirmed email',
  paying: 'Customers with a running report / alerts',
  not_paying: 'Customers without a running report',
  referrers: 'Referral programme members',
};

function audienceWhere(audience, mobile) {
  switch (audience) {
    case 'one': return { sql: `u.mobile = $1`, params: [String(mobile || '').replace(/\D/g, '').slice(-10)] };
    case 'all': return { sql: 'true', params: [] };
    case 'paying': return { sql: PAYING, params: [] };
    case 'not_paying': return { sql: `NOT ${PAYING}`, params: [] };
    case 'referrers': return { sql: `EXISTS (SELECT 1 FROM referral_links l WHERE l.user_id = u.id)`, params: [] };
    default: return null;
  }
}

/** Who would receive it, and who would not (and why). */
async function preview({ audience, mobile, subject, body }) {
  const w = audienceWhere(audience, mobile);
  if (!w) return { ok: false, error: 'audience', message: 'Choose who to send to.' };
  const all = await db.one(`SELECT count(*)::int AS n FROM users u WHERE ${w.sql}`, w.params);
  const ok = await db.one(`SELECT count(*)::int AS n FROM users u WHERE ${w.sql} AND ${MAILABLE}`, w.params);
  const only = await C.onlyTo();
  const sample = (await db.one(`SELECT u.* FROM users u WHERE ${w.sql} AND ${MAILABLE} ORDER BY u.id LIMIT 1`, w.params))
    || { display_name: 'Customer', email_token: 'preview' };
  const mail = C.announcementMail(sample, { subject, body });
  return {
    ok: true,
    matched: all.n,
    will_send: only.length ? (await db.one(
      `SELECT count(*)::int AS n FROM users u WHERE ${w.sql} AND ${MAILABLE} AND lower(u.email) = ANY($${w.params.length + 1}::text[])`,
      [...w.params, only])).n : ok.n,
    confirmed: ok.n,
    test_mode: only,
    html: mail.html,
  };
}

/** Send the email to the test address(es) only: test mode's list, else the admin's. */
async function testSend({ subject, body }, admin) {
  const only = await C.onlyTo();
  const to = only.length ? only : await mailer.adminRecipients();
  if (!to.length) return { ok: false, message: 'No test address: set customer_email_only_to or ADMINMAIL.' };
  const mail = C.announcementMail({ display_name: admin?.name || 'Admin', email_token: 'test' }, { subject, body });
  const out = await mailer.send({ to, subject: `[TEST] ${mail.subject}`, html: mail.html, text: mail.text });
  return { ok: out.ok, to: to.join(', '), message: out.ok ? null : out.error };
}

/** Queue it for the audience. Returns the campaign with its recipient count. */
async function queue({ audience, mobile, subject, body }, adminId) {
  if (String(await settings.get('admin_customer_email_enabled', 'true')).toLowerCase() === 'false') {
    return { ok: false, error: 'off', message: 'Writing to customers is switched off in Settings.' };
  }
  const w = audienceWhere(audience, mobile);
  if (!w) return { ok: false, error: 'audience', message: 'Choose who to send to.' };
  const subj = String(subject || '').trim().slice(0, 150);
  const text = String(body || '').trim().slice(0, 10000);
  if (subj.length < 3) return { ok: false, error: 'subject', message: 'Please write a subject.' };
  if (text.length < 10) return { ok: false, error: 'body', message: 'Please write the message.' };
  return db.tx(async (c) => {
    const camp = (await c.query(
      `INSERT INTO admin_email_campaigns (admin_id, audience, target_mobile, subject, body)
            VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [adminId, audience, audience === 'one' ? w.params[0] : null, subj, text])).rows[0];
    const ins = await c.query(
      `INSERT INTO customer_emails (user_id, kind, to_email, subject, campaign_id)
       SELECT u.id, 'announcement', u.email, $${w.params.length + 1}, $${w.params.length + 2}
         FROM users u WHERE ${w.sql} AND ${MAILABLE}`,
      [...w.params, subj, camp.id]);
    await c.query(`UPDATE admin_email_campaigns SET recipients = $2 WHERE id = $1`, [camp.id, ins.rowCount]);
    return { ok: true, campaign: { ...camp, id: String(camp.id), recipients: ins.rowCount } };
  });
}

async function cancel(campaignId) {
  const r = await db.query(
    `UPDATE customer_emails SET status = 'skipped', error = 'cancelled by admin'
      WHERE campaign_id = $1 AND status = 'pending'`, [campaignId]);
  await db.query(`UPDATE admin_email_campaigns SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'queued'`, [campaignId]);
  return { ok: true, cancelled: r.rowCount };
}

async function campaigns() {
  const { rows } = await db.query(
    `SELECT c.*, a.name AS admin_name,
            count(e.*) FILTER (WHERE e.status = 'sent')::int AS sent,
            count(e.*) FILTER (WHERE e.status = 'pending')::int AS pending,
            count(e.*) FILTER (WHERE e.status = 'skipped')::int AS skipped,
            count(e.*) FILTER (WHERE e.status = 'failed')::int AS failed
       FROM admin_email_campaigns c
       LEFT JOIN admin_users a ON a.id = c.admin_id
       LEFT JOIN customer_emails e ON e.campaign_id = c.id
      GROUP BY c.id, a.name ORDER BY c.id DESC LIMIT 100`);
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

/** Every customer email, newest first. */
async function log({ kind = null, status = null, q = '', limit = 200 } = {}) {
  const term = String(q || '').trim().toLowerCase();
  const { rows } = await db.query(
    `SELECT e.id, e.kind, e.to_email, e.subject, e.status, e.error, e.ist_date, e.vehicles, e.created_at, e.sent_at,
            e.campaign_id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name
       FROM customer_emails e JOIN users u ON u.id = e.user_id
      WHERE ($1::text IS NULL OR e.kind = $1) AND ($2::text IS NULL OR e.status = $2)
        AND ($3 = '' OR lower(e.to_email) LIKE '%' || $3 || '%' OR u.mobile LIKE '%' || $3 || '%')
      ORDER BY e.id DESC LIMIT $4`, [kind, status, term, Math.min(500, limit)]);
  const totals = await db.query(
    `SELECT kind, status, count(*)::int AS n FROM customer_emails
      WHERE created_at > now() - interval '30 days' GROUP BY kind, status`);
  const reach = await db.one(
    `SELECT count(*) FILTER (WHERE email IS NOT NULL)::int AS with_email,
            count(*) FILTER (WHERE ${MAILABLE.replace(/u\./g, '')})::int AS mailable,
            count(*) FILTER (WHERE email_unsubscribed_at IS NOT NULL)::int AS unsubscribed
       FROM users`);
  return { rows: rows.map((r) => ({ ...r, id: String(r.id), campaign_id: r.campaign_id ? String(r.campaign_id) : null })),
           totals: totals.rows, reach };
}

module.exports = { AUDIENCES, preview, testSend, queue, cancel, campaigns, log };
