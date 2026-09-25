/**
 * src/admin/search.js — one search box for the whole panel (user,
 * 2026-09-25, operations module phase 7).
 *
 * Vehicle number (any spacing), customer name / phone / internal id,
 * WhatsApp number, payment id (pay_…), order id (order_…, plink_…), internal
 * transaction id, report number (RPT…), invoice number (INV…) — answered in
 * groups: vehicles, customers, payments, reports, events. Referral ids are not
 * searched: GaadiPe has no referral programme for now. Phones come back as
 * stored; the server masks them for roles that may not see them.
 */

const db = require('../db');
const plate = require('../util/plate');

async function search(term, { limit = 6 } = {}) {
  const t = String(term || '').trim();
  if (t.length < 2) return { q: t, groups: {} };
  const digits = t.replace(/\D/g, '');
  const reg = plate.normalize(t);
  const idNum = /^#?\d{1,12}$/.test(t) ? Number(t.replace('#', '')) : null;
  const lim = Math.min(20, limit);

  const [vehicles, customers, payments, reports, events] = await Promise.all([
    reg.length >= 2 ? require('./vehicles').quick(t).then((r) => r.rows.slice(0, lim)).catch(() => []) : [],
    db.query(
      `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.created_at,
              (SELECT count(*) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid')::int AS paid
         FROM users u
        WHERE ($1 <> '' AND length($1) >= 4 AND u.mobile LIKE '%' || $1)
           OR (length($2) >= 2 AND coalesce(u.display_name, u.wa_profile_name) ILIKE '%' || $2 || '%')
           OR ($3::bigint IS NOT NULL AND u.id = $3)
        ORDER BY u.id DESC LIMIT ${lim}`, [digits, t.replace(/[%_]/g, ''), idNum]),
    db.query(
      `SELECT p.id, p.payment_id, p.order_id, p.status, p.amount_paise, p.created_at, u.mobile, v.reg_no
         FROM payments p LEFT JOIN users u ON u.id = p.user_id
         LEFT JOIN vehicles v ON p.raw ? 'vehicle_id' AND v.id::text = p.raw->>'vehicle_id'
        WHERE p.payment_id ILIKE $1 || '%' OR p.order_id ILIKE $1 || '%' OR ($2::bigint IS NOT NULL AND p.id = $2)
           OR p.id IN (SELECT payment_id FROM invoices WHERE invoice_number ILIKE $1 || '%')
        ORDER BY p.id DESC LIMIT ${lim}`, [t, idNum]),
    db.query(
      `SELECT r.id, r.report_number, r.reg_no, r.created_at, r.payment_id
         FROM vehicle_reports r WHERE r.report_number ILIKE $1 || '%' OR ($2 <> '' AND r.reg_no = $2)
        ORDER BY r.id DESC LIMIT ${lim}`, [t, reg.length >= 5 ? reg : '']),
    db.query(
      `SELECT e.id, e.occurred_at, e.name, e.channel, e.reg_no, e.mobile, e.payment_id
         FROM events e
        WHERE ($1::bigint IS NOT NULL AND e.id = $1) OR e.event_key = $2
           OR ($3 <> '' AND length($3) >= 5 AND e.reg_no = $3)
        ORDER BY e.id DESC LIMIT ${lim}`, [idNum, t, reg]),
  ]);
  return {
    q: t,
    groups: {
      vehicles: vehicles.map((v) => ({ ...v, to: `/vehicles/${v.reg_no}` })),
      customers: customers.rows.map((c) => ({ ...c, id: String(c.id), to: `/journey?user=${c.id}` })),
      payments: payments.rows.map((p) => ({ ...p, id: String(p.id), to: `/profitability?tab=transactions&q=${encodeURIComponent(p.payment_id || p.id)}` })),
      reports: reports.rows.map((r) => ({ ...r, id: String(r.id), to: `/vehicles/${r.reg_no}#reports` })),
      events: events.rows.map((e) => ({ ...e, id: String(e.id), to: e.reg_no ? `/vehicles/${e.reg_no}#timeline` : e.mobile ? `/journey?mobile=${e.mobile}` : '/command' })),
    },
  };
}

module.exports = { search };
