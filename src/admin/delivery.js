/**
 * src/admin/delivery.js — Report delivery status (user, 2026-09-25,
 * operations module phase 7): each report in a period — generated, then
 * delivered as a PDF, as a link only, failed, or not recorded — and every
 * paid report that has no report yet (the customer paid and has nothing).
 */

const db = require('../db');
const command = require('./command');

async function status(q = {}) {
  const r = command.resolve({ range: q.range || '7d', from: q.from, to: q.to, compare: 'none' });
  const [reports, missing] = await Promise.all([
    db.query(
      `SELECT r.id, r.report_number, r.reg_no, r.channel, r.created_at, r.payment_id, u.mobile,
              d.status AS delivery, d.occurred_at AS delivered_at, d.metadata->>'via' AS via
         FROM vehicle_reports r LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN LATERAL (SELECT e.status, e.occurred_at, e.metadata FROM events e
                             WHERE e.name = 'report_delivered' AND (e.payment_id = r.payment_id OR e.metadata->>'report_number' = r.report_number)
                             ORDER BY e.id DESC LIMIT 1) d ON true
        WHERE r.created_at >= $1 AND r.created_at < $2 ORDER BY r.created_at DESC LIMIT 500`, [r.from, r.to]),
    db.query(
      `SELECT p.id, p.paid_at, u.mobile, v.reg_no FROM payments p
         JOIN plans pl ON pl.id = p.plan_id LEFT JOIN users u ON u.id = p.user_id
         LEFT JOIN vehicles v ON p.raw ? 'vehicle_id' AND v.id::text = p.raw->>'vehicle_id'
        WHERE p.status = 'paid' AND pl.kind = 'report' AND p.amount_paise > 0
          AND NOT EXISTS (SELECT 1 FROM vehicle_reports x WHERE x.payment_id = p.id)
        ORDER BY p.paid_at DESC LIMIT 100`),
  ]);
  const rows = reports.rows.map((x) => ({
    ...x, id: String(x.id), payment_id: x.payment_id ? String(x.payment_id) : null,
    state: x.delivery === 'ok' ? 'delivered' : x.delivery === 'link_only' ? 'link_only' : x.delivery ? 'failed'
      : x.channel === 'web' ? 'downloaded' : 'not_recorded',
  }));
  const count = (s) => rows.filter((x) => x.state === s).length;
  return {
    range: { label: r.label },
    totals: { generated: rows.length, delivered: count('delivered'), link_only: count('link_only'), failed: count('failed'),
      downloaded: count('downloaded'), not_recorded: count('not_recorded'), paid_without_report: missing.rows.length },
    rows, missing: missing.rows.map((m) => ({ ...m, id: String(m.id) })),
    notes: { not_recorded: 'Reports sent before delivery was tracked, or on WhatsApp without a delivery event.' },
  };
}

module.exports = { status };
