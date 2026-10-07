/**
 * src/admin/web.js — THE WEBSITE ADMIN (user, 2026-10-07: "a new admin just
 * for the website and chat": visitors, sign-ins, the chat, Google and Meta ads,
 * free checks against paid reports). Read-only: every function here SELECTs.
 *
 *   overview({ range })        totals, the funnel, sources and a time series
 *   visitors({ range, ... })   website visitors, newest first, with their source
 *   trail(visitorId)           one visitor's pages and events
 *   customers({ range, q })    customers who signed in on the website
 *   freeChecks({ range })      the chat's checks without signing in
 *
 * WHERE EACH NUMBER COMES FROM
 *   visitors      events (channel web) — a browser's random id, never a person
 *   source        the visitor's FIRST touch (visitors.first_touch): google_ads,
 *                 meta_ads, google, social, direct … (events/track.js touchOf)
 *   chat opens    page views of /chat
 *   free checks   event_log chat_anon_check (site/chat.js)
 *   sign-ins      site_sign_ins 'signed_in'; NEW = that customer's first ever
 *   web checks    event_log vehicle_check(_repeat) tagged channel web
 *   paid          payments 'paid' started on the website (raw.channel = web)
 * A customer's source is the source of the earliest visitor linked to them.
 * Ranges are whole Indian days: today, 7d (today and the 6 before), 30d.
 */

const db = require('../db');

const RANGES = { today: 0, '7d': 6, '30d': 29 };
const rangeOf = (r) => (Object.prototype.hasOwnProperty.call(RANGES, r) ? r : 'today');
/* The start of the range: midnight IST, N days back. Passed to SQL as $1. */
const FROM = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - make_interval(days => $1::int)) AT TIME ZONE 'Asia/Kolkata'`;

const n = (v) => Number(v) || 0;
const SRC = `coalesce(nullif(v.first_touch->>'source', ''), 'direct')`;

async function overview({ range } = {}) {
  const r = rangeOf(range);
  const days = RANGES[r];

  const t = await db.one(
    `WITH seen AS (
       SELECT DISTINCT visitor_id FROM events
        WHERE channel = 'web' AND visitor_id IS NOT NULL AND occurred_at >= ${FROM})
     SELECT
       (SELECT count(*) FROM seen)                                                              AS visitors,
       (SELECT count(*) FROM visitors WHERE first_seen_at >= ${FROM})                          AS new_visitors,
       (SELECT count(DISTINCT visitor_id) FROM events
         WHERE channel = 'web' AND name = 'page_view' AND page LIKE '/chat%' AND occurred_at >= ${FROM}) AS chat_visitors,
       (SELECT count(*) FROM event_log WHERE kind = 'chat_anon_check' AND created_at >= ${FROM}) AS free_checks,
       (SELECT count(*) FROM event_log WHERE kind = 'chat_anon_check' AND created_at >= ${FROM}
                                         AND (detail->>'found')::boolean)                       AS free_found,
       (SELECT count(DISTINCT coalesce(nullif(detail->>'device', ''), detail->>'ip')) FROM event_log
         WHERE kind = 'chat_anon_check' AND created_at >= ${FROM})                              AS free_checkers,
       (SELECT count(*) FROM site_sign_ins WHERE event = 'code_requested' AND created_at >= ${FROM}) AS codes_requested,
       (SELECT count(*) FROM site_sign_ins WHERE event = 'signed_in' AND created_at >= ${FROM})  AS sign_ins,
       (SELECT count(DISTINCT user_id) FROM site_sign_ins WHERE event = 'signed_in' AND created_at >= ${FROM}) AS signed_in_customers,
       (SELECT count(*) FROM (SELECT user_id, min(created_at) AS first FROM site_sign_ins
                               WHERE event = 'signed_in' AND user_id IS NOT NULL GROUP BY user_id) f
         WHERE f.first >= ${FROM})                                                              AS new_customers,
       (SELECT count(*) FROM event_log WHERE kind IN ('vehicle_check', 'vehicle_check_repeat')
                                         AND detail->>'channel' = 'web' AND created_at >= ${FROM}) AS web_checks,
       (SELECT count(DISTINCT coalesce(payment_id::text, event_key)) FROM events
         WHERE channel = 'web' AND name = 'payment_page_viewed' AND occurred_at >= ${FROM})       AS pay_opened,
       (SELECT count(*) FROM payments WHERE status = 'paid' AND raw->>'channel' = 'web' AND coalesce(paid_at, created_at) >= ${FROM}) AS paid,
       (SELECT coalesce(sum(amount_paise), 0) FROM payments
         WHERE status = 'paid' AND raw->>'channel' = 'web' AND coalesce(paid_at, created_at) >= ${FROM}) AS revenue_paise,
       (SELECT count(*) FROM customer_push_subscriptions)                                      AS push_devices,
       (SELECT count(DISTINCT user_id) FROM customer_push_subscriptions)                       AS push_customers,
       (SELECT count(*) FROM site_sessions WHERE ended_at IS NULL AND last_used_at > now() - interval '15 minutes') AS online_now`,
    [days]);
  const totals = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, n(v)]));

  /* Each source: visitors in the range, and what the customers it brought did in the range. */
  const { rows: sources } = await db.query(
    `WITH seen AS (
       SELECT DISTINCT e.visitor_id FROM events e
        WHERE e.channel = 'web' AND e.visitor_id IS NOT NULL AND e.occurred_at >= ${FROM}),
     vis AS (
       SELECT ${SRC} AS source, count(*) AS visitors,
              count(*) FILTER (WHERE v.first_seen_at >= ${FROM}) AS new_visitors
         FROM seen s JOIN visitors v ON v.visitor_id = s.visitor_id GROUP BY 1),
     cust_src AS (
       SELECT DISTINCT ON (v.user_id) v.user_id, ${SRC} AS source
         FROM visitors v WHERE v.user_id IS NOT NULL ORDER BY v.user_id, v.first_seen_at),
     signed AS (
       SELECT coalesce(c.source, 'unknown') AS source, count(DISTINCT s.user_id) AS signed_in
         FROM site_sign_ins s LEFT JOIN cust_src c ON c.user_id = s.user_id
        WHERE s.event = 'signed_in' AND s.created_at >= ${FROM} GROUP BY 1),
     paid AS (
       SELECT coalesce(c.source, 'unknown') AS source, count(*) AS paid, count(DISTINCT p.user_id) AS payers,
              sum(p.amount_paise) AS revenue_paise
         FROM payments p LEFT JOIN cust_src c ON c.user_id = p.user_id
        WHERE p.status = 'paid' AND p.raw->>'channel' = 'web' AND coalesce(p.paid_at, p.created_at) >= ${FROM} GROUP BY 1)
     SELECT coalesce(vis.source, signed.source, paid.source) AS source,
            coalesce(vis.visitors, 0) AS visitors, coalesce(vis.new_visitors, 0) AS new_visitors,
            coalesce(signed.signed_in, 0) AS signed_in, coalesce(paid.paid, 0) AS paid,
            coalesce(paid.payers, 0) AS payers, coalesce(paid.revenue_paise, 0) AS revenue_paise
       FROM vis FULL JOIN signed ON signed.source = vis.source
                FULL JOIN paid ON paid.source = coalesce(vis.source, signed.source)
      ORDER BY 2 DESC, 4 DESC`,
    [days]);

  /* Hour by hour for today, day by day otherwise (IST). */
  const grain = r === 'today' ? 'hour' : 'day';
  const { rows: series } = await db.query(
    `WITH b AS (
       SELECT generate_series(date_trunc($2, ${FROM} AT TIME ZONE 'Asia/Kolkata'),
                              date_trunc($2, now() AT TIME ZONE 'Asia/Kolkata'),
                              ('1 ' || $2)::interval) AS at)
     SELECT to_char(b.at, CASE WHEN $2 = 'hour' THEN 'HH24:00' ELSE 'DD Mon' END) AS label,
       (SELECT count(DISTINCT visitor_id) FROM events
         WHERE channel = 'web' AND date_trunc($2, occurred_at AT TIME ZONE 'Asia/Kolkata') = b.at)  AS visitors,
       (SELECT count(*) FROM event_log
         WHERE kind = 'chat_anon_check' AND date_trunc($2, created_at AT TIME ZONE 'Asia/Kolkata') = b.at) AS free_checks,
       (SELECT count(*) FROM site_sign_ins
         WHERE event = 'signed_in' AND date_trunc($2, created_at AT TIME ZONE 'Asia/Kolkata') = b.at) AS sign_ins,
       (SELECT count(*) FROM payments
         WHERE status = 'paid' AND raw->>'channel' = 'web'
           AND date_trunc($2, coalesce(paid_at, created_at) AT TIME ZONE 'Asia/Kolkata') = b.at)    AS paid
       FROM b ORDER BY b.at`,
    [days, grain]);

  return {
    range: r, grain, totals,
    funnel: [
      { key: 'visitors', label: 'Visited the site', n: totals.visitors },
      { key: 'chat', label: 'Opened the chat', n: totals.chat_visitors },
      { key: 'free', label: 'Ran a free check', n: totals.free_checkers },
      { key: 'signed', label: 'Signed in', n: totals.signed_in_customers },
      { key: 'pay', label: 'Opened the ₹19 payment', n: totals.pay_opened },
      { key: 'paid', label: 'Paid', n: totals.paid },
    ],
    sources: sources.map((s) => ({ source: s.source, visitors: n(s.visitors), new_visitors: n(s.new_visitors),
      signed_in: n(s.signed_in), paid: n(s.paid), payers: n(s.payers), revenue_paise: n(s.revenue_paise) })),
    series: series.map((s) => ({ label: s.label, visitors: n(s.visitors), free_checks: n(s.free_checks),
      sign_ins: n(s.sign_ins), paid: n(s.paid) })),
  };
}

/** Website visitors seen in the range, most recent first. */
async function visitors({ range, source = '', q = '', limit = 100, offset = 0 } = {}) {
  const r = rangeOf(range);
  const term = String(q || '').trim().replace(/[%_]/g, '');
  const { rows } = await db.query(
    `WITH seen AS (
       SELECT visitor_id, max(occurred_at) AS last_at, count(*) FILTER (WHERE name = 'page_view') AS views,
              bool_or(page LIKE '/chat%') AS chat
         FROM events WHERE channel = 'web' AND visitor_id IS NOT NULL AND occurred_at >= ${FROM}
        GROUP BY visitor_id)
     SELECT v.visitor_id, v.first_seen_at, s.last_at, s.views, s.chat, ${SRC} AS source,
            coalesce(v.last_touch->>'campaign', v.first_touch->>'campaign') AS campaign,
            v.first_touch->>'landing' AS landing, v.device, v.place, v.user_id,
            u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
            (SELECT count(*) FROM payments p WHERE p.user_id = v.user_id AND p.status = 'paid') AS paid,
            count(*) OVER () AS total_rows
       FROM seen s JOIN visitors v ON v.visitor_id = s.visitor_id
       LEFT JOIN users u ON u.id = v.user_id
      WHERE ($2 = '' OR ${SRC} = $2)
        AND ($3 = '' OR u.mobile ILIKE '%' || $3 || '%' OR v.place->>'city' ILIKE '%' || $3 || '%'
             OR coalesce(u.display_name, u.wa_profile_name, '') ILIKE '%' || $3 || '%' OR v.visitor_id = $3)
      ORDER BY s.last_at DESC LIMIT $4 OFFSET $5`,
    [RANGES[r], String(source || ''), term, Math.min(200, Number(limit) || 100), Number(offset) || 0]);
  return {
    range: r, total: rows[0] ? n(rows[0].total_rows) : 0,
    rows: rows.map(({ total_rows, ...x }) => ({ ...x, views: n(x.views), paid: n(x.paid),
      user_id: x.user_id ? String(x.user_id) : null })),
  };
}

/** One visitor: their pages and events, oldest first. */
async function trail(visitorId) {
  const id = String(visitorId || '').slice(0, 64);
  const v = await db.one(
    `SELECT v.*, ${SRC} AS source, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name
       FROM visitors v LEFT JOIN users u ON u.id = v.user_id WHERE v.visitor_id = $1`, [id]);
  if (!v) return { visitor: null, rows: [] };
  const { rows } = await db.query(
    `SELECT occurred_at, name, page, source, campaign, reg_no, status, amount_paise,
            metadata->>'label' AS label, metadata->>'referrer' AS referrer
       FROM events WHERE visitor_id = $1 ORDER BY occurred_at DESC LIMIT 300`, [id]);
  return { visitor: { ...v, user_id: v.user_id ? String(v.user_id) : null }, rows: rows.reverse() };
}

/** Customers who signed in on the website, most recently active first. */
async function customers({ range, q = '', limit = 100, offset = 0 } = {}) {
  const r = rangeOf(range);
  const term = String(q || '').trim().replace(/[%_]/g, '');
  const { rows } = await db.query(
    `WITH active AS (
       SELECT user_id, min(created_at) AS first_at FROM site_sign_ins
        WHERE event = 'signed_in' AND user_id IS NOT NULL GROUP BY user_id),
     cust_src AS (
       SELECT DISTINCT ON (v.user_id) v.user_id, ${SRC} AS source, v.place
         FROM visitors v WHERE v.user_id IS NOT NULL ORDER BY v.user_id, v.first_seen_at)
     SELECT u.id AS user_id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.email,
            a.first_at, (a.first_at >= ${FROM}) AS is_new,
            (SELECT max(coalesce(last_used_at, created_at)) FROM site_sessions WHERE user_id = u.id) AS last_seen,
            (SELECT count(*) FROM site_sessions WHERE user_id = u.id AND ended_at IS NULL) AS open_sessions,
            coalesce(c.source, 'unknown') AS source, c.place,
            (SELECT count(*) FROM event_log WHERE user_id = u.id AND kind IN ('vehicle_check', 'vehicle_check_repeat')
                                              AND created_at >= ${FROM}) AS checks,
            (SELECT count(*) FROM payments WHERE user_id = u.id AND status = 'paid') AS paid,
            (SELECT coalesce(sum(amount_paise), 0) FROM payments WHERE user_id = u.id AND status = 'paid') AS revenue_paise,
            (SELECT count(*) FROM customer_push_subscriptions WHERE user_id = u.id) AS push_devices,
            count(*) OVER () AS total_rows
       FROM active a JOIN users u ON u.id = a.user_id
       LEFT JOIN cust_src c ON c.user_id = u.id
      WHERE (EXISTS (SELECT 1 FROM site_sessions s WHERE s.user_id = u.id
                      AND coalesce(s.last_used_at, s.created_at) >= ${FROM})
             OR a.first_at >= ${FROM})
        AND ($2 = '' OR u.mobile ILIKE '%' || $2 || '%' OR coalesce(u.display_name, u.wa_profile_name, '') ILIKE '%' || $2 || '%'
             OR coalesce(u.email, '') ILIKE '%' || $2 || '%')
      ORDER BY last_seen DESC NULLS LAST LIMIT $3 OFFSET $4`,
    [RANGES[r], term, Math.min(200, Number(limit) || 100), Number(offset) || 0]);
  return {
    range: r, total: rows[0] ? n(rows[0].total_rows) : 0,
    rows: rows.map(({ total_rows, ...x }) => ({ ...x, user_id: String(x.user_id), open_sessions: n(x.open_sessions),
      checks: n(x.checks), paid: n(x.paid), revenue_paise: n(x.revenue_paise), push_devices: n(x.push_devices) })),
  };
}

/** The chat's free checks without signing in. */
async function freeChecks({ range, limit = 200 } = {}) {
  const r = rangeOf(range);
  const { rows } = await db.query(
    `SELECT id, created_at, detail->>'reg_no' AS reg_no, (detail->>'found')::boolean AS found,
            left(coalesce(nullif(detail->>'device', ''), '—'), 8) AS device, left(detail->>'ip', 8) AS ip
       FROM event_log WHERE kind = 'chat_anon_check' AND created_at >= ${FROM}
      ORDER BY id DESC LIMIT $2`, [RANGES[r], Math.min(500, Number(limit) || 200)]);
  const s = await db.one(
    `SELECT count(*) AS checks, count(*) FILTER (WHERE (detail->>'found')::boolean) AS found,
            count(DISTINCT coalesce(nullif(detail->>'device', ''), detail->>'ip')) AS devices,
            count(DISTINCT detail->>'reg_no') AS vehicles
       FROM event_log WHERE kind = 'chat_anon_check' AND created_at >= ${FROM}`, [RANGES[r]]);
  /* Devices that ran a free check and then signed in — the chat doing its job. */
  const conv = await db.one(
    `SELECT count(DISTINCT e.detail->>'device') AS n
       FROM event_log e JOIN site_sign_ins s ON s.device_id = e.detail->>'device' AND s.event = 'signed_in'
                                           AND s.created_at >= e.created_at
      WHERE e.kind = 'chat_anon_check' AND e.created_at >= ${FROM} AND coalesce(e.detail->>'device', '') <> ''`,
    [RANGES[r]]);
  return {
    range: r,
    summary: { checks: n(s.checks), found: n(s.found), devices: n(s.devices), vehicles: n(s.vehicles), then_signed_in: n(conv.n) },
    rows: rows.map((x) => ({ ...x, id: String(x.id) })),
  };
}

/* ─────────────────────────────────────────────────────── the log ── */

/*
 * EVERY EVENT AND TRIGGER, IN WORDS (user, 2026-10-07: "clear logs for every
 * event or trigger"). One time-ordered list from the tables that already
 * record each thing — nothing new is written for it:
 *   visit     events: arrived (with the source), payment page opened; page views on request
 *   chat      event_log: free checks in the chat
 *   sign-in   site_sign_ins: code sent, signed in, failed, signed out
 *   check     event_log: website checks after signing in, full reports viewed
 *   payment   payments started on the website: created, paid, failed
 *   notify    customer_push_subscriptions: notifications allowed
 *   email     admin_notifications: every email sent to the admin, or why it failed
 */
const LOG_KINDS = ['visit', 'chat', 'signin', 'check', 'payment', 'notify', 'email'];

async function log({ range, kind = '', q = '', pages = false, limit = 200 } = {}) {
  const r = rangeOf(range);
  const want = LOG_KINDS.includes(kind) ? [kind] : LOG_KINDS;
  const term = String(q || '').trim().replace(/[%_]/g, '');
  const lim = Math.min(500, Number(limit) || 200);
  const parts = [];
  if (want.includes('visit')) {
    parts.push(`SELECT e.occurred_at AS at, 'visit' AS kind, e.name AS what, e.mobile, e.reg_no,
                       coalesce(e.page, '') AS detail, e.source, e.visitor_id AS ref, true AS ok
                  FROM events e
                 WHERE e.channel = 'web' AND e.occurred_at >= ${FROM}
                   AND (e.name IN ('session_started', 'payment_page_viewed', 'cta_clicked', 'whatsapp_cta_clicked')
                        OR ($4 AND e.name = 'page_view'))`);
  }
  if (want.includes('chat')) {
    parts.push(`SELECT created_at, 'chat', 'chat_anon_check', NULL, detail->>'reg_no',
                       left(coalesce(nullif(detail->>'device', ''), ''), 10), NULL, id::text, coalesce((detail->>'found')::boolean, false)
                  FROM event_log WHERE kind = 'chat_anon_check' AND created_at >= ${FROM}`);
  }
  if (want.includes('signin')) {
    parts.push(`SELECT s.created_at, 'signin', s.event, s.mobile, NULL,
                       concat_ws(' · ', nullif(concat_ws(' ', s.device_vendor, s.device_model), ''), s.browser, s.city), NULL, s.id::text,
                       s.event NOT IN ('sign_in_failed', 'code_refused')
                  FROM site_sign_ins s WHERE s.created_at >= ${FROM}`);
  }
  if (want.includes('check')) {
    parts.push(`SELECT l.created_at, 'check', l.kind, u.mobile, l.detail->>'reg_no', '', NULL, l.id::text,
                       coalesce((l.detail->>'found')::boolean, true)
                  FROM event_log l LEFT JOIN users u ON u.id = l.user_id
                 WHERE l.created_at >= ${FROM}
                   AND ((l.kind IN ('vehicle_check', 'vehicle_check_repeat') AND l.detail->>'channel' = 'web') OR l.kind = 'full_view')`);
  }
  if (want.includes('payment')) {
    parts.push(`SELECT coalesce(p.paid_at, p.created_at), 'payment', 'payment_' || p.status, u.mobile, coalesce(p.raw->>'reg_no', ''),
                       '₹' || to_char(p.amount_paise / 100.0, 'FM999990.00'), NULL, p.id::text, p.status NOT IN ('failed', 'cancelled')
                  FROM payments p LEFT JOIN users u ON u.id = p.user_id
                 WHERE p.raw->>'channel' = 'web' AND coalesce(p.paid_at, p.created_at) >= ${FROM}`);
  }
  if (want.includes('notify')) {
    parts.push(`SELECT c.created_at, 'notify', 'push_on', u.mobile, NULL, left(coalesce(c.device, ''), 80), NULL, c.id::text, true
                  FROM customer_push_subscriptions c LEFT JOIN users u ON u.id = c.user_id WHERE c.created_at >= ${FROM}`);
  }
  if (want.includes('email')) {
    parts.push(`SELECT coalesce(n.sent_at, n.created_at), 'email', n.kind, NULL, NULL,
                       CASE WHEN n.status = 'sent' THEN coalesce(n.sent_to, '') ELSE coalesce(n.last_error, n.status) END,
                       n.status, n.ref, n.status = 'sent'
                  FROM admin_notifications n WHERE coalesce(n.sent_at, n.created_at) >= ${FROM}`);
  }
  const { rows } = await db.query(
    `SELECT * FROM (${parts.join('\n UNION ALL \n')}) x (at, kind, what, mobile, reg_no, detail, source, ref, ok)
      WHERE ($2 = '' OR x.mobile ILIKE '%' || $2 || '%' OR x.reg_no ILIKE '%' || $2 || '%' OR x.detail ILIKE '%' || $2 || '%')
        AND $4::boolean IS NOT NULL   -- $4 (page views) is used only when visits are asked for; named here so every filter binds it
      ORDER BY x.at DESC LIMIT $3`,
    [RANGES[r], term, lim, Boolean(pages)]);
  const counts = await db.one(
    `SELECT (SELECT count(*) FROM events WHERE channel = 'web' AND name = 'session_started' AND occurred_at >= ${FROM}) AS visit,
            (SELECT count(*) FROM event_log WHERE kind = 'chat_anon_check' AND created_at >= ${FROM}) AS chat,
            (SELECT count(*) FROM site_sign_ins WHERE created_at >= ${FROM}) AS signin,
            (SELECT count(*) FROM event_log WHERE created_at >= ${FROM}
               AND ((kind IN ('vehicle_check', 'vehicle_check_repeat') AND detail->>'channel' = 'web') OR kind = 'full_view')) AS "check",
            (SELECT count(*) FROM payments WHERE raw->>'channel' = 'web' AND coalesce(paid_at, created_at) >= ${FROM}) AS payment,
            (SELECT count(*) FROM customer_push_subscriptions WHERE created_at >= ${FROM}) AS notify,
            (SELECT count(*) FROM admin_notifications WHERE coalesce(sent_at, created_at) >= ${FROM}) AS email`,
    [RANGES[r]]);
  return {
    range: r,
    counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, n(v)])),
    rows: rows.map((x) => ({ ...x, ok: x.ok !== false })),
  };
}

/* ──────────────────────────────────────────────── emails to the admin ── */

/* Every email the admin can get, with its switch (jobs/notify.js), in the order shown. */
const EMAILS = [
  ['notify_sign_ins', 'sign_in', 'Someone signs in on the website', 'New customers are marked 🆕, with where they came from'],
  ['notify_web_checks', 'web_check', 'A vehicle is checked on the website', 'After signing in: new vehicle or repeat, found or not'],
  ['notify_chat_checks', 'chat_check', 'A free check in the chat', 'Without signing in — can be many a day while ads run'],
  ['notify_push_on', 'push_on', 'A customer allows notifications', 'On a phone or computer'],
  ['notify_payments', 'payment', 'A payment succeeds', 'With the invoice PDF'],
  ['notify_left_at_payment', 'left_at_pay', 'A ₹19 payment is left unpaid', '30 minutes after the payment page was opened'],
  ['notify_contact', 'contact', 'A Contact us message', ''],
  ['notify_feedback', 'feedback', 'A feedback note', ''],
  ['daily_summary_email', 'daily_summary', 'The daily summary', 'At 11:55 pm, the whole day'],
];

async function emails() {
  const keys = EMAILS.map((e) => e[0]);
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [keys]);
  const val = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const { rows: stats } = await db.query(
    `SELECT kind, count(*) FILTER (WHERE status = 'sent' AND sent_at >= now() - interval '1 day') AS sent_day,
            count(*) FILTER (WHERE status <> 'sent' AND created_at >= now() - interval '1 day') AS failed_day,
            max(sent_at) AS last_sent
       FROM admin_notifications WHERE kind = ANY($1) GROUP BY kind`, [EMAILS.map((e) => e[1])]);
  const by = Object.fromEntries(stats.map((s) => [s.kind, s]));
  const mailer = require('../mail/mailer');
  return {
    configured: mailer.configured(),
    to: await mailer.adminRecipients(),
    rows: EMAILS.map(([key, kind, label, hint]) => ({
      key, kind, label, hint,
      exists: key in val,
      on: key in val ? String(val[key]).toLowerCase() !== 'false' : true,
      sent_day: n(by[kind]?.sent_day), failed_day: n(by[kind]?.failed_day), last_sent: by[kind]?.last_sent || null,
    })),
  };
}

/** Switch one email on or off. Only the keys above, and only ones that exist. */
async function setEmail(key, on) {
  if (!EMAILS.some((e) => e[0] === key)) throw Object.assign(new Error('Not an email switch.'), { status: 400 });
  const { rowCount } = await db.query(
    `UPDATE app_settings SET value = $2, modified_at = now() WHERE key = $1`, [key, on ? 'true' : 'false']);
  if (!rowCount) throw Object.assign(new Error('That switch is not on this server yet — run the migrations.'), { status: 409 });
  require('../util/settings').refresh();
  return { ok: true, key, on };
}

module.exports = { overview, visitors, trail, customers, freeChecks, log, emails, setEmail, _test: { rangeOf } };
