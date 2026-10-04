/**
 * src/admin/gifts.js — gift full reports to paying customers (user, 2026-10-04).
 *
 * The admin picks paying customers (never those who only had free checks),
 * gives each N full reports — e.g. 2 — valid for D days, and can tell them on
 * WhatsApp with an approved template. On WhatsApp, "Full report" then uses one
 * gift instead of asking for ₹19, until none are left; each use is a normal
 * report (same PDF, download window and alerts) issued through pay/free.js,
 * with no invoice since nothing was paid.
 *
 * Stored as report_credits rows: source 'gift', reward 'free_report', one row
 * per report given. People who said STOP or are blocked are left out.
 */

const db = require('../db');

const mask = (m) => (m ? `••••••${String(m).slice(-4)}` : null);
const PAID = `p.status = 'paid' AND p.amount_paise > 0`;

/** Paying customers to choose from, with what gifts they still hold. */
async function customers({ q = '', limit = 300 } = {}) {
  const term = String(q || '').trim();
  const digits = term.replace(/\D/g, '');
  const { rows } = await db.query(
    `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
            count(p.*)::int AS paid, max(p.paid_at) AS last_paid,
            (SELECT count(*)::int FROM report_credits c WHERE c.user_id = u.id AND c.source = 'gift'
               AND c.used_at IS NULL AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())) AS gifts_left,
            ws.last_inbound_at
       FROM users u
       JOIN payments p ON p.user_id = u.id AND ${PAID}
       LEFT JOIN whatsapp_sessions ws ON ws.mobile = u.mobile
      WHERE ws.wa_opt_out_at IS NULL AND u.erased_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.kind = 'mobile' AND b.value = u.mobile AND b.released_at IS NULL)
        AND ($1 = '' OR coalesce(u.display_name, u.wa_profile_name, '') ILIKE '%' || $1 || '%' OR ($2 <> '' AND u.mobile LIKE '%' || $2 || '%'))
      GROUP BY u.id, ws.last_inbound_at
      ORDER BY max(p.paid_at) DESC LIMIT $3`, [term, digits, limit]);
  return { rows: rows.map((r) => ({ ...r, id: String(r.id), masked: mask(r.mobile) })) };
}

/**
 * Give `count` reports each to these customers, valid `days`. Optionally tell
 * them: `message` = { template_name, language, variables } where a variable may
 * be 'gift_count' or 'gift_expiry' besides the broadcast fields.
 */
async function grant({ userIds = [], count = 2, days = 30, note = '', message = null }, adminId) {
  const n = Math.round(Number(count));
  const d = Math.round(Number(days));
  if (!Number.isInteger(n) || n < 1 || n > 10) throw Object.assign(new Error('Give between 1 and 10 reports.'), { status: 400 });
  if (!Number.isInteger(d) || d < 1 || d > 365) throw Object.assign(new Error('Validity must be 1 to 365 days.'), { status: 400 });
  const ids = [...new Set((userIds || []).map(String))].filter((x) => /^\d+$/.test(x));
  if (!ids.length) throw Object.assign(new Error('Choose at least one customer.'), { status: 400 });
  // Paying customers only — the rule the panel promises.
  const { rows: ok } = await db.query(
    `SELECT u.id, u.mobile FROM users u
      WHERE u.id = ANY($1::bigint[]) AND EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND ${PAID})`, [ids]);
  if (!ok.length) throw Object.assign(new Error('None of them has paid for a report.'), { status: 400 });
  const expires = new Date(Date.now() + d * 864e5);
  await db.tx(async (c) => {
    for (const u of ok) {
      for (let i = 0; i < n; i += 1) {
        await c.query(
          `INSERT INTO report_credits (user_id, source, reward, expires_at) VALUES ($1, 'gift', 'free_report', $2)`, [u.id, expires]);
      }
    }
  });
  await require('./auth').audit({ adminId, action: 'gift_reports', detail: { customers: ok.length, each: n, days: d, note: String(note || '').slice(0, 200) } });

  let broadcast = null;
  if (message?.template_name) {
    const until = expires.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const variables = (message.variables || []).map((v) => (v === 'gift_count' ? String(n) : v === 'gift_expiry' ? until : v));
    broadcast = await require('./broadcasts').queue({
      template_name: message.template_name, language: message.language || 'en', variables,
      mobiles: ok.map((u) => u.mobile), note: `Gift: ${n} full report${n === 1 ? '' : 's'} each, valid ${d} days`,
    }, adminId);
  }
  return { ok: true, customers: ok.length, each: n, expires_at: expires.toISOString(), skipped: ids.length - ok.length, broadcast };
}

/** Gifts this customer can still use, oldest expiry first. */
async function available(userId) {
  const { rows } = await db.query(
    `SELECT id, expires_at FROM report_credits
      WHERE user_id = $1 AND source = 'gift' AND used_at IS NULL AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY expires_at NULLS LAST, id`, [userId]);
  return rows;
}

/**
 * Use one gift for this vehicle: the report is issued and delivered as a paid
 * one would be. Returns { ok, left } or { ok: false, error }.
 */
async function use(userId, regNo) {
  const credit = await db.one(
    `UPDATE report_credits SET used_at = now(), used_reg_no = $2
      WHERE id = (SELECT id FROM report_credits WHERE user_id = $1 AND source = 'gift' AND used_at IS NULL AND revoked_at IS NULL
                    AND (expires_at IS NULL OR expires_at > now()) ORDER BY expires_at NULLS LAST, id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id`, [userId, regNo]);
  if (!credit) return { ok: false, error: 'no_gift' };
  const out = await require('../pay/free').issueFree({ userId, regNo, source: 'gift', creditId: credit.id, reason: 'gift report' })
    .catch((e) => ({ ok: false, error: e.message }));
  if (!out.ok || out.already) {
    // Not issued (or they already hold a valid report): the gift goes back, untouched.
    await db.query(`UPDATE report_credits SET used_at = NULL, used_reg_no = NULL WHERE id = $1`, [credit.id]);
    return { ok: false, error: out.error };
  }
  await db.query(`UPDATE report_credits SET payment_id = $2 WHERE id = $1`, [credit.id, out.paymentId || null]);
  return { ok: true, left: (await available(userId)).length };
}

/** Take back this customer's unused gifts. */
async function revoke(userId, adminId) {
  const { rowCount } = await db.query(
    `UPDATE report_credits SET revoked_at = now(), revoked_reason = 'taken back by the admin'
      WHERE user_id = $1 AND source = 'gift' AND used_at IS NULL AND revoked_at IS NULL`, [userId]);
  await require('./auth').audit({ adminId, action: 'gift_reports_revoked', detail: { user_id: String(userId), revoked: rowCount } });
  return { ok: true, revoked: rowCount };
}

/** What was given and used, for the page's summary. */
async function summary() {
  return db.one(
    `SELECT count(*)::int AS given,
            count(*) FILTER (WHERE used_at IS NOT NULL)::int AS used,
            count(*) FILTER (WHERE used_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))::int AS open,
            count(DISTINCT user_id)::int AS customers
       FROM report_credits WHERE source = 'gift'`);
}

module.exports = { customers, grant, available, use, revoke, summary };
