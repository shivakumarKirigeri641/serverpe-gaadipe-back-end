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
const device = require('../site/device');

/* What the list can be sorted by. Names, not raw SQL, so a query parameter can
   never reach the ORDER BY clause. */

/*
 * A SESSION, MEASURED (user, 2026-09-18). Duration runs to the sign-out for a
 * session that was signed out, otherwise to its last activity. "Online" means
 * active in the last 15 minutes and not ended.
 */
const SESSION_COLS = `
  s.id, s.user_id, s.created_at, s.last_used_at, s.ended_at, s.ended_reason, s.request_count,
  s.ip, s.last_ip, s.device_id, s.user_agent, s.sign_in_id,
  greatest(0, extract(epoch FROM (CASE WHEN s.ended_reason = 'signed_out' AND s.ended_at IS NOT NULL
                                       THEN s.ended_at ELSE s.last_used_at END) - s.created_at))::int AS seconds,
  CASE WHEN s.ended_at IS NULL AND s.last_used_at > now() - interval '15 minutes' THEN 'online'
       WHEN s.ended_at IS NULL THEN 'idle'
       ELSE coalesce(s.ended_reason, 'ended') END AS state`;

const SORTS = {
  last_seen: 'u.last_seen_at DESC NULLS LAST',
  joined: 'u.created_at DESC',
  paid: 'paid_paise DESC NULLS LAST',
  checks: 'vehicles_checked DESC',
  reports: 'reports_bought DESC',
  sign_ins: 'sign_ins DESC NULLS LAST',
  time: 'seconds_on_site DESC NULLS LAST',
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
     ), visits AS (
       SELECT user_id, count(*) AS sign_ins, sum(seconds) AS seconds_on_site,
              max(created_at) AS last_sign_in_at,
              max(ended_at) FILTER (WHERE ended_reason = 'signed_out') AS last_sign_out_at,
              count(*) FILTER (WHERE state = 'online') AS online
         FROM (SELECT ${SESSION_COLS} FROM site_sessions s) x GROUP BY user_id
     )
     SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.is_internal, u.is_paused,
            coalesce(vi.sign_ins, 0) AS sign_ins, coalesce(vi.seconds_on_site, 0) AS seconds_on_site,
            vi.last_sign_in_at, vi.last_sign_out_at, coalesce(vi.online, 0) > 0 AS online,
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
            -- Until when vehicle alerts run: shown as "Alerts on · until …", so
            -- it is never mistaken for being signed in (user, 2026-09-21).
            (SELECT max(s.ends_on) FROM subscriptions s
              WHERE s.user_id = u.id AND s.is_active
                AND s.ends_on >= CURRENT_DATE)                      AS alerts_until,
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
       LEFT JOIN visits vi   ON vi.user_id = u.id
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
      sign_ins: Number(r.sign_ins || 0),
      seconds_on_site: Number(r.seconds_on_site || 0),
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

  const [vehicles, payments, reports, invoices, messages, consent, devices, calls, alerts, feedback, signIns, sessions] =
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
      // Every sign-in step for this person, by account or by the number typed.
      db.query(
        `SELECT * FROM site_sign_ins WHERE user_id = $1 OR mobile = $2
          ORDER BY id DESC LIMIT 500`, [userId, user.mobile]),
      db.query(
        `SELECT ${SESSION_COLS}, g.city, g.region, g.country, g.device_model, g.device_vendor,
                g.device_type, g.os, g.os_version, g.browser, g.browser_version
           FROM site_sessions s LEFT JOIN site_sign_ins g ON g.id = s.sign_in_id
          WHERE s.user_id = $1 ORDER BY s.id DESC LIMIT 500`, [userId]),
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
    sign_ins: signIns.rows.map(r => ({ ...r, id: String(r.id), described: device.describe(r),
      name: user.display_name || user.wa_profile_name || null,
      place: device.placeOf(r.city || r.region || r.country ? r : device.locate(r.ip)) })),
    sessions: sessions.rows.map(sessionOut),
    visits: summarise(sessions.rows),
  };
}

/** Pause or resume a customer's alerts without blocking them outright. */
async function setPaused(userId, paused) {
  const { rows } = await db.query(
    `UPDATE users SET is_paused = $2, modified_at = now() WHERE id = $1 RETURNING id, is_paused`,
    [userId, Boolean(paused)]);
  return rows[0] || null;
}

/* One session as the panel shows it: device and place from its sign-in step
   when there is one, parsed from the user agent otherwise. */
function sessionOut(r) {
  const parsed = r.device_type ? r : { ...device.parseUA(r.user_agent) };
  return {
    ...r,
    id: String(r.id),
    user_id: r.user_id ? String(r.user_id) : null,
    seconds: Number(r.seconds || 0),
    request_count: Number(r.request_count || 0),
    described: device.describe(parsed),
    place: device.placeOf(r.city || r.region || r.country ? r : device.locate(r.ip)),
  };
}

/* The whole of someone's visits, in the figures people ask for first. */
function summarise(rows) {
  const n = rows.length;
  const secs = rows.map((r) => Number(r.seconds || 0));
  const total = secs.reduce((t, x) => t + x, 0);
  const signedOut = rows.filter((r) => r.ended_reason === 'signed_out');
  return {
    sign_ins: n,
    online_now: rows.some((r) => r.state === 'online'),
    open_sessions: rows.filter((r) => !r.ended_at).length,
    seconds_total: total,
    seconds_average: n ? Math.round(total / n) : 0,
    seconds_longest: n ? Math.max(...secs) : 0,
    requests_total: rows.reduce((t, r) => t + Number(r.request_count || 0), 0),
    signed_out: signedOut.length,
    expired: rows.filter((r) => r.ended_reason === 'expired').length,
    first_sign_in_at: n ? rows[n - 1].created_at : null,
    last_sign_in_at: n ? rows[0].created_at : null,
    last_sign_out_at: signedOut.length ? signedOut[0].ended_at : null,
    last_active_at: n ? rows.reduce((m, r) => (new Date(r.last_used_at) > new Date(m) ? r.last_used_at : m), rows[0].last_used_at) : null,
    devices: new Set(rows.map((r) => r.device_id).filter(Boolean)).size,
  };
}

module.exports = { list, detail, setPaused, SORTS, SESSION_COLS, sessionOut, summarise };
