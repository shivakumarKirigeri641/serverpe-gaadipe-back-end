/**
 * src/pay/free.js — a full report with nothing paid (user, 2026-09-21).
 *
 * Two ways in: a referral reward the customer uses, or the owner granting one
 * from the panel. Either way it goes through EXACTLY the paid path — a payment
 * row (Rs.0, gateway 'free'), billing.activate for the subscription and the
 * watch, deliverPaidReport for the report — so a free report is the same report,
 * with the same download and alert periods. The differences:
 *
 *   * no GST tax invoice (nothing was paid; a Rs.0 supply is not invoiced)
 *   * no "payment received" email to the admin (jobs/notify.js skips gateway 'free')
 */

const db = require('../db');
const billing = require('./billing');
const reports = require('./report');

/**
 * Issue a free report of `regNo` to `userId`.
 * source:      'referral' | 'admin'
 * declaration: the customer's ticked declaration (site), or null (admin grant)
 * Returns { ok, report?, already?, error? }.
 */
async function issueFree({ userId, regNo, source, creditId = null, adminId = null, reason = null,
                           declaration = null, ctx = {} }) {
  const existing = await reports.validFor(userId, regNo);
  if (existing) return { ok: true, already: true, report: existing };

  const vehicle = await db.one(`SELECT id FROM vehicles WHERE reg_no = $1`, [regNo]);
  if (!vehicle) return { ok: false, error: 'not_checked' };
  const plan = await billing.reportPlan();
  if (!plan) return { ok: false, error: 'no_plan' };

  const pay = (await db.query(
    `INSERT INTO payments (user_id, plan_id, amount_paise, status, gateway, raw)
          VALUES ($1, $2, 0, 'created', 'free', $3) RETURNING *`,
    [userId, plan.id, JSON.stringify({
      vehicle_id: vehicle.id, channel: 'web', free: source,
      credit_id: creditId ? String(creditId) : null, admin_id: adminId ? String(adminId) : null,
      reason: reason || null, paid_from: { ip: ctx.ip || null, userAgent: ctx.user_agent || null, channel: 'web' },
    })])).rows[0];

  // The declaration the report prints, recorded against this payment as a paid
  // purchase records it (pay/consent.js reads it back).
  if (declaration) {
    await db.query(
      `INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'purchase_consent', $3)`,
      [userId, vehicle.id, JSON.stringify({ ...declaration, reg_no: regNo, amount_paise: 0, plan: plan.code,
        channel: 'web', free: source, declared: true, payment_row: String(pay.id), at: new Date().toISOString() })]);
  }

  const result = await billing.activate({
    paymentRowId: pay.id, razorpayPaymentId: `free_${source}_${pay.id}`, orderId: null, raw: { via: `free:${source}` },
  });
  if (!result.activated) return { ok: false, error: result.reason || 'not_activated' };

  const { deliverPaidReport } = require('../routes/payments');
  const delivered = await deliverPaidReport(pay.id, { withText: false });
  await db.query(
    `INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'free_report', $3)`,
    [userId, vehicle.id, JSON.stringify({ source, reg_no: regNo, payment_row: String(pay.id),
      credit_id: creditId ? String(creditId) : null, admin_id: adminId ? String(adminId) : null,
      reason, delivered: delivered.ok })]);
  if (!delivered.ok) return { ok: false, error: delivered.reason || 'not_delivered', paymentId: pay.id };
  return { ok: true, report: delivered.report, paymentId: pay.id };
}

/**
 * Take a report away (owner, rare): the download, the watch and the daily
 * updates stop now. Nothing is deleted — the report row, payment and invoice
 * stay as the record. Returns what was switched off.
 */
async function revoke({ userId, regNo, adminId, reason }) {
  return db.tx(async (c) => {
    const v = (await c.query(`SELECT id FROM vehicles WHERE reg_no = $1`, [regNo])).rows[0];
    if (!v) return { ok: false, error: 'unknown_vehicle' };
    const reps = await c.query(
      `UPDATE vehicle_reports SET valid_until = now()
        WHERE user_id = $1 AND reg_no = $2 AND valid_until > now() RETURNING id, payment_id`, [userId, regNo]);
    const subs = await c.query(
      `UPDATE subscriptions SET is_active = false, modified_at = now()
        WHERE user_id = $1 AND vehicle_id = $2 AND is_active RETURNING id`, [userId, v.id]);
    const w = await c.query(
      `UPDATE watches SET is_active = false, modified_at = now()
        WHERE user_id = $1 AND vehicle_id = $2 AND is_active RETURNING id`, [userId, v.id]);
    const paidRows = reps.rows.map((r) => r.payment_id).filter(Boolean);
    const paid = paidRows.length ? (await c.query(
      `SELECT coalesce(sum(amount_paise), 0)::int AS paise FROM payments WHERE id = ANY($1::bigint[]) AND gateway <> 'free'`,
      [paidRows])).rows[0].paise : 0;
    await c.query(
      `INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'report_revoked', $3)`,
      [userId, v.id, JSON.stringify({ reg_no: regNo, admin_id: String(adminId), reason,
        reports: reps.rowCount, subscriptions: subs.rowCount, watches: w.rowCount, paid_paise: paid })]);
    return { ok: true, reports: reps.rowCount, subscriptions: subs.rowCount, watches: w.rowCount, paid_paise: paid };
  });
}

module.exports = { issueFree, revoke };
