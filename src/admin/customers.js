/**
 * src/admin/customers.js — every customer, and everything known about one.
 *
 * TWO SHAPES, ON PURPOSE:
 *
 *   list()   one row per person with the numbers that decide who to look at —
 *            vehicles checked, reports bought, money paid, last seen, blocked.
 *            Everything the row shows is computed in SQL, because a panel that
 *            fetches a list and then asks a question per row is a panel that
 *            takes ten seconds to open.
 *
 *   detail() one person, in full: their vehicles, payments, reports, invoices,
 *            conversation, consent, devices and lookups. This is what the panel
 *            opens on a tap, so it is one round trip rather than eight.
 *
 * Reading a customer's details is itself audited. The panel shows mobile
 * numbers and vehicles; "who looked at this person" has to be answerable.
 */

const db = require('../db');

/* What the list can be sorted by. Names, not raw SQL, so a query parameter can
   never reach the ORDER BY clause. */
const SORTS = {
  last_seen: 'u.last_seen_at DESC NULLS LAST',
  joined: 'u.created_at DESC',
  paid: 'paid_paise DESC NULLS LAST',
  checks: 'vehicles_checked DESC',
  reports: 'reports_bought DESC',
};

/**
 * The matrix: one row per customer.
 *
 * `q` matches a mobile number, a name or any registration they have checked —
 * the three things anyone actually searches by.
 */
async function list({ q = '', sort = 'last_seen', limit = 50, offset = 0,
                      blocked = null, paying = null } = {}) {
  const order = SORTS[sort] || SORTS.last_seen;
  const term = String(q || '').trim();
  const digits = term.replace(/\D/g, '');
  const plate = term.toUpperCase().replace(/[^A-Z0-9]/g, '');

  const { rows } = await db.query(
    `WITH per_user AS (
       SELECT u.id,
              count(DISTINCT uv.vehicle_id)                          AS vehicles_checked,
              coalesce(sum(uv.check_count), 0)                       AS checks_made,
              max(uv.last_checked_at)                                AS last_check_at
         FROM users u
         LEFT JOIN user_vehicles uv ON uv.user_id = u.id
        GROUP BY u.id
     ), money AS (
       SELECT user_id,
              count(*) FILTER (WHERE status = 'paid')                AS payments_made,
              coalesce(sum(amount_paise) FILTER (WHERE status = 'paid'), 0) AS paid_paise,
              coalesce(sum(amount_paise) FILTER (WHERE status = 'refunded'), 0) AS refunded_paise,
              max(paid_at) FILTER (WHERE status = 'paid')            AS last_paid_at
         FROM payments GROUP BY user_id
     ), docs AS (
       SELECT user_id, count(*) AS reports_bought FROM vehicle_reports GROUP BY user_id
     )
     SELECT u.id, u.mobile, u.wa_profile_name AS name, u.is_internal, u.is_paused,
            u.created_at, u.last_seen_at,
            pu.vehicles_checked, pu.checks_made, pu.last_check_at,
            coalesce(m.payments_made, 0) AS payments_made,
            coalesce(m.paid_paise, 0)    AS paid_paise,
            coalesce(m.refunded_paise, 0) AS refunded_paise,
            m.last_paid_at,
            coalesce(d.reports_bought, 0) AS reports_bought,
            EXISTS (SELECT 1 FROM subscriptions s
                     WHERE s.user_id = u.id AND s.is_active
                       AND s.ends_on >= CURRENT_DATE)               AS active,
            EXISTS (SELECT 1 FROM blocks b
                     WHERE b.kind = 'mobile' AND b.value = u.mobile
                       AND b.released_at IS NULL)                   AS blocked,
            (SELECT max(created_at) FROM whatsapp_messages w
              WHERE w.mobile = u.mobile)                            AS last_message_at,
            (SELECT count(*) FROM whatsapp_messages w
              WHERE w.mobile = u.mobile)                            AS messages,
            count(*) OVER ()                                        AS total_rows
       FROM users u
       LEFT JOIN per_user pu ON pu.id = u.id
       LEFT JOIN money m     ON m.user_id = u.id
       LEFT JOIN docs d      ON d.user_id = u.id
      WHERE ($1 = '' OR u.mobile LIKE '%' || $2 || '%'
             OR u.wa_profile_name ILIKE '%' || $1 || '%'
             OR EXISTS (SELECT 1 FROM user_vehicles uv2
                          JOIN vehicles v2 ON v2.id = uv2.vehicle_id
                         WHERE uv2.user_id = u.id AND v2.reg_no LIKE '%' || $3 || '%'))
        AND ($4::boolean IS NULL OR $4 = EXISTS (
              SELECT 1 FROM blocks b WHERE b.kind = 'mobile' AND b.value = u.mobile
                 AND b.released_at IS NULL))
        AND ($5::boolean IS NULL OR $5 = EXISTS (
              SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.is_active
                 AND s.ends_on >= CURRENT_DATE))
      ORDER BY ${order}
      LIMIT $6 OFFSET $7`,
    [term, digits, plate, blocked, paying, Math.min(200, limit), offset]);

  const total = rows[0] ? Number(rows[0].total_rows) : 0;
  return {
    total,
    rows: rows.map(({ total_rows, ...r }) => ({
      ...r,
      id: String(r.id),
      vehicles_checked: Number(r.vehicles_checked || 0),
      checks_made: Number(r.checks_made || 0),
      payments_made: Number(r.payments_made || 0),
      paid_paise: Number(r.paid_paise || 0),
      refunded_paise: Number(r.refunded_paise || 0),
      reports_bought: Number(r.reports_bought || 0),
      messages: Number(r.messages || 0),
    })),
  };
}

/** One customer, with everything the panel shows on a tap. */
async function detail(userId) {
  const user = await db.one(
    `SELECT u.*,
            EXISTS (SELECT 1 FROM blocks b
                     WHERE b.kind = 'mobile' AND b.value = u.mobile
                       AND b.released_at IS NULL) AS blocked
       FROM users u WHERE u.id = $1`, [userId]);
  if (!user) return null;

  const [vehicles, payments, reports, invoices, messages, consent, devices, calls, alerts, feedback] =
    await Promise.all([
      db.query(
        `SELECT v.id, v.reg_no, v.maker, v.model, v.fuel, v.vehicle_class,
                v.insurance_upto, v.pucc_upto, v.fitness_upto, v.tax_upto, v.permit_upto,
                v.financer, v.blacklist_status, v.rc_status, v.owner_serial,
                uv.relation, uv.check_count, uv.last_checked_at,
                EXISTS (SELECT 1 FROM watches w
                         WHERE w.user_id = uv.user_id AND w.vehicle_id = v.id AND w.is_active) AS watched,
                EXISTS (SELECT 1 FROM blocks b
                         WHERE b.kind = 'vehicle' AND b.value = v.reg_no
                           AND b.released_at IS NULL) AS blocked,
                (SELECT max(ends_on) FROM subscriptions s
                  WHERE s.user_id = uv.user_id AND s.vehicle_id = v.id AND s.is_active) AS watched_until
           FROM user_vehicles uv
           JOIN vehicles v ON v.id = uv.vehicle_id
          WHERE uv.user_id = $1
          ORDER BY uv.last_checked_at DESC NULLS LAST`, [userId]),
      db.query(
        `SELECT p.id, p.amount_paise, p.status, p.gateway, p.order_id, p.payment_id,
                p.refund_id, p.created_at, p.paid_at, p.refunded_at,
                pl.code AS plan_code, pl.name AS plan_name, pl.kind AS plan_kind,
                v.reg_no
           FROM payments p
           LEFT JOIN plans pl ON pl.id = p.plan_id
           LEFT JOIN vehicles v ON v.id = (p.raw->>'vehicle_id')::bigint
          WHERE p.user_id = $1 ORDER BY p.id DESC`, [userId]),
      db.query(
        `SELECT id, report_number, reg_no, created_at, valid_until, pdf_path,
                channel, device, ip, user_agent
           FROM vehicle_reports WHERE user_id = $1 ORDER BY id DESC`, [userId]),
      db.query(
        `SELECT id, invoice_number, invoice_date, base_paise, total_paise,
                cgst_paise, sgst_paise, igst_paise, place_of_supply, pdf_path
           FROM invoices WHERE user_id = $1 ORDER BY id DESC`, [userId]),
      db.query(
        `SELECT direction, message_type, body, template_name, error_message, created_at
           FROM whatsapp_messages WHERE mobile = $1
          ORDER BY id DESC LIMIT 100`, [user.mobile]),
      db.query(
        `SELECT detail, created_at FROM event_log
          WHERE kind = 'consent_accepted' AND detail->>'mobile' = $1
          ORDER BY id DESC`, [user.mobile]),
      // Every device this person has been seen on — only the checkout page ever
      // sees a browser, so this is the whole of what we know.
      db.query(
        `SELECT DISTINCT ON (ip, user_agent) ip, user_agent, device, channel, created_at
           FROM vehicle_reports WHERE user_id = $1 AND (ip IS NOT NULL OR user_agent IS NOT NULL)
          ORDER BY ip, user_agent, created_at DESC`, [userId]),
      db.query(
        `SELECT dataset, provider_path, cache_hit, ok, outcome, error_code,
                duration_ms, cost_paise, reg_no, created_at
           FROM api_calls WHERE user_id = $1 ORDER BY id DESC LIMIT 100`, [userId]),
      db.query(
        `SELECT vehicle_id, detail, created_at FROM event_log
          WHERE user_id = $1 AND kind = 'watch_alert' ORDER BY id DESC LIMIT 50`, [userId]),
      db.query(
        `SELECT id, reg_no, body, created_at FROM feedback WHERE user_id = $1
          ORDER BY id DESC`, [userId]),
    ]);

  const totals = {
    paid_paise: payments.rows.filter(p => p.status === 'paid')
      .reduce((n, p) => n + p.amount_paise, 0),
    refunded_paise: payments.rows.filter(p => p.status === 'refunded')
      .reduce((n, p) => n + p.amount_paise, 0),
    ulip_calls: calls.rows.filter(c => !c.cache_hit).length,
    ulip_cost_paise: calls.rows.reduce((n, c) => n + (c.cost_paise || 0), 0),
  };

  return {
    user: { ...user, id: String(user.id) },
    totals,
    vehicles: vehicles.rows.map(v => ({ ...v, id: String(v.id) })),
    payments: payments.rows.map(p => ({ ...p, id: String(p.id) })),
    reports: reports.rows.map(r => ({ ...r, id: String(r.id), has_pdf: Boolean(r.pdf_path) })),
    invoices: invoices.rows.map(i => ({ ...i, id: String(i.id), has_pdf: Boolean(i.pdf_path) })),
    messages: messages.rows,
    consent: consent.rows,
    devices: devices.rows,
    calls: calls.rows,
    alerts: alerts.rows,
    feedback: feedback.rows.map(f => ({ ...f, id: String(f.id) })),
  };
}

/** Pause or resume a customer's alerts without blocking them outright. */
async function setPaused(userId, paused) {
  const { rows } = await db.query(
    `UPDATE users SET is_paused = $2, modified_at = now() WHERE id = $1 RETURNING id, is_paused`,
    [userId, Boolean(paused)]);
  return rows[0] || null;
}

module.exports = { list, detail, setPaused, SORTS };
