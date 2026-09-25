/**
 * src/jobs/reconDaily.js — the daily payment reconciliation (user,
 * 2026-09-25, operations module phase 2).
 *
 * Once a day, after 03:00 IST, GaadiPe's payments of the last two days are
 * compared with Razorpay's (src/admin/recon.js) and the result kept for the
 * Payment Reconciliation screen. Comparing only — no payment is changed.
 * Anything that does not match raises an alert for a person to look at.
 */

const db = require('../db');

async function tick() {
  const ist = new Date(Date.now() + 330 * 60000);
  if (ist.getUTCHours() < 3) return;
  const done = await db.one(
    `SELECT 1 AS ok FROM recon_runs WHERE admin_id IS NULL
        AND started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' LIMIT 1`);
  if (done) return;
  const to = new Date();
  const from = new Date(to.getTime() - 2 * 86400000);
  const out = await require('../admin/recon').run({ from, to });
  const s = out.summary || {};
  const problems = (s.mismatched || 0) + (s.missing || 0) + (s.refund_issues || 0) + (s.requires_review || 0);
  if (out.ok && problems) {
    await require('../admin/alerts').raise({
      key: 'payment_recon_mismatch', severity: 'warning', source: 'payments',
      title: `Payment reconciliation: ${problems} to review`,
      description: `${s.mismatched || 0} mismatched, ${s.missing || 0} missing, ${s.refund_issues || 0} refund issue(s), ${s.requires_review || 0} needing review.`,
      detail: { run_id: out.id, to: '/payments/reconciliation' },
    }).catch(() => {});
  }
}

function start(everySeconds = 3600) {
  setInterval(require('../util/heartbeat').wrap('payment_reconciliation', tick, everySeconds), everySeconds * 1000).unref();
}

module.exports = { start, tick };
