/**
 * src/admin/freeReports.js — every free report, one by one (user, 2026-09-21).
 *
 * Two ways a report is given free:
 *   referral   a credit earned when a parent bought QuizPe premium through the
 *              customer's link — then used on a vehicle, or still available,
 *              expired, or revoked
 *   admin      the owner granted it from Report access
 * For each: who, how it was earned, when, on which vehicle and report, and
 * what it cost GaadiPe (the report price not charged).
 */

const db = require('../db');
const billing = require('../pay/billing');

async function list({ state = null, q = '' } = {}) {
  const term = String(q || '').trim();
  const digits = term.replace(/\D/g, '');
  const { rows } = await db.query(
    `WITH credits AS (
       SELECT 'referral'::text AS source, c.id::text AS ref, c.user_id, c.created_at AS earned_at, c.expires_at,
              c.reward, c.price_paise,
              c.used_at, c.used_reg_no AS reg_no, c.revoked_at, c.revoked_reason AS note,
              r.mobile_masked AS parent, r.code, r.quizpe_payment, r.quizpe_amount, r.tapped_at,
              vr.report_number, NULL::text AS admin_name,
              CASE WHEN c.revoked_at IS NOT NULL THEN 'revoked' WHEN c.used_at IS NOT NULL THEN 'used'
                   WHEN c.expires_at <= now() THEN 'expired' ELSE 'available' END AS state
         FROM report_credits c
         LEFT JOIN quizpe_referrals r ON r.id = c.referral_id
         LEFT JOIN vehicle_reports vr ON vr.payment_id = c.payment_id AND c.used_at IS NOT NULL
     ), grants AS (
       SELECT 'admin'::text AS source, p.id::text AS ref, p.user_id, p.paid_at AS earned_at, NULL::timestamptz AS expires_at,
              'free_report'::text AS reward, NULL::integer AS price_paise,
              p.paid_at AS used_at, v.reg_no, NULL::timestamptz AS revoked_at, p.raw->>'reason' AS note,
              NULL::text AS parent, NULL::text AS code, NULL::text AS quizpe_payment, NULL::numeric AS quizpe_amount,
              NULL::timestamptz AS tapped_at, vr.report_number, a.name AS admin_name, 'used'::text AS state
         FROM payments p
         LEFT JOIN vehicles v ON v.id = (p.raw->>'vehicle_id')::bigint
         LEFT JOIN vehicle_reports vr ON vr.payment_id = p.id
         LEFT JOIN admin_users a ON a.id::text = p.raw->>'admin_id'
        WHERE p.gateway = 'free' AND p.raw->>'free' = 'admin' AND p.status = 'paid'
     )
     SELECT x.*, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name
       FROM (SELECT * FROM credits UNION ALL SELECT * FROM grants) x
       JOIN users u ON u.id = x.user_id
      WHERE ($1::text IS NULL OR x.state = $1)
        AND ($2 = '' OR u.mobile LIKE '%' || $3 || '%' OR x.reg_no ILIKE '%' || $2 || '%'
             OR coalesce(u.display_name, '') ILIKE '%' || $2 || '%')
      ORDER BY x.earned_at DESC NULLS LAST LIMIT 500`, [state, term, digits || term]);

  const plan = await billing.reportPlan().catch(() => null);
  const price = plan?.price_paise || 0;
  const count = (s) => rows.filter((r) => r.state === s).length;
  const used = rows.filter((r) => r.state === 'used');
  const reducedUsed = used.filter((r) => r.reward === 'report_at_price');
  return {
    rows: rows.map((r) => ({ ...r, user_id: String(r.user_id) })),
    totals: {
      earned: rows.filter((r) => r.source === 'referral' && r.reward !== 'report_at_price').length,
      reduced: rows.filter((r) => r.reward === 'report_at_price').length,
      granted: rows.filter((r) => r.source === 'admin').length,
      used: count('used'), available: count('available'), expired: count('expired'), revoked: count('revoked'),
      // What GaadiPe did not charge for the reports actually given.
      // A free report forgoes the whole price; a reduced one only the difference.
      value_paise: (used.length - reducedUsed.length) * price
        + reducedUsed.reduce((s, r) => s + Math.max(0, price - Number(r.price_paise || 0)), 0),
      quizpe_rupees: rows.reduce((s, r) => s + Number(r.quizpe_amount || 0), 0),
    },
  };
}

/** One customer: their link, every parent through it, every free report. */
async function customer(userId) {
  const u = await db.one(
    `SELECT id, mobile, coalesce(display_name, wa_profile_name) AS name, email, email_verified_at,
            quizpe_consent_at, quizpe_consent_withdrawn_at, deactivated_at, created_at
       FROM users WHERE id = $1`, [userId]);
  if (!u) return null;
  const link = await db.one(
    `SELECT l.*, (SELECT count(*) FROM referral_clicks c WHERE c.link_id = l.id AND c.outcome = 'opened')::int AS opened,
            (SELECT count(*) FROM referral_clicks c WHERE c.link_id = l.id AND c.outcome = 'own_link')::int AS own_opens
       FROM referral_links l WHERE l.user_id = $1`, [userId]);
  const parents = await db.query(
    `SELECT id, mobile_masked, code, status, status_reason, tapped_at, expires_at, rewarded_at, quizpe_payment, quizpe_amount
       FROM quizpe_referrals WHERE referrer_id = $1 ORDER BY id DESC`, [userId]);
  const all = await list({});
  return {
    customer: { ...u, id: String(u.id) },
    link: link ? { code: link.code, active: link.is_active, disabled_reason: link.disabled_reason,
                   opened: link.opened, own_opens: link.own_opens, created_at: link.created_at, reset_at: link.reset_at } : null,
    parents: parents.rows.map((p) => ({ ...p, id: String(p.id) })),
    free_reports: all.rows.filter((r) => r.user_id === String(userId)),
  };
}

module.exports = { list, customer };
