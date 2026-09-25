/**
 * src/admin/payments.js — the payments desk (user, 2026-09-25, command center
 * phase 5).
 * ---------------------------------------------------------------------------
 *   summary(range)  started, paid, not completed, failed attempts, refunded;
 *                   success and failure rates; gross and what is left; revenue
 *                   per paying customer; revenue by day, week or month; and
 *                   revenue by where the customer first came from.
 *   list(range, …)  each payment with its own split: GST, the gateway fee and
 *                   its GST, the records-API cost of the lookups behind it,
 *                   and the net contribution — plus method and source.
 *   detail(id)      one payment: its events, Razorpay's webhooks, its report.
 *
 * Money is split by splitOf() — the same rates as Revenue & GST — so the two
 * screens can never disagree. A payment names its vehicle by raw.vehicle_id.
 * Failed attempts are Razorpay's payment.failed webhooks, which the webhook
 * handler records in event_log.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const command = require('./command');
const { splitOf } = require('./stats');

/* Where the paying customer first came from — the same reading as Customers. */
const SOURCE = `coalesce(
  (SELECT vi.first_touch->>'source' FROM visitors vi WHERE vi.mobile = u.mobile ORDER BY vi.first_seen_at LIMIT 1),
  (SELECT CASE WHEN ws.attribution->>'channel' = 'whatsapp_ad' THEN 'meta_ads' END FROM whatsapp_sessions ws WHERE ws.mobile = u.mobile),
  CASE WHEN u.signup_channel = 'web' THEN 'website' ELSE 'whatsapp_direct' END)`;

/* Razorpay's payment.failed webhooks, per payment row ("gp-42-x" → 42). */
const FAILED = `SELECT DISTINCT nullif(split_part(detail->>'reference_id', '-', 2), '')::bigint AS payment_id
                  FROM event_log WHERE kind = 'razorpay_webhook' AND detail->>'event' = 'payment.failed'
                   AND detail->>'reference_id' LIKE 'gp-%'`;

const GRAINS = { day: ['day', 'YYYY-MM-DD'], week: ['week', 'YYYY-MM-DD'], month: ['month', 'YYYY-MM'] };

async function summary(q = {}) {
  const r = command.resolve(q);
  const [g, gFmt] = GRAINS[q.grain] || GRAINS.day;
  const [n, series, bySource, byMethod] = await Promise.all([
    db.one(
      `SELECT count(*) FILTER (WHERE p.created_at >= $1 AND p.created_at < $2)::int AS started,
              count(*) FILTER (WHERE p.created_at >= $1 AND p.created_at < $2 AND p.status = 'paid')::int AS started_paid,
              count(*) FILTER (WHERE p.status = 'paid' AND p.paid_at >= $1 AND p.paid_at < $2)::int AS paid,
              count(*) FILTER (WHERE p.status = 'created' AND p.created_at >= $1 AND p.created_at < $2
                                 AND p.created_at < now() - interval '30 minutes')::int AS not_completed,
              count(*) FILTER (WHERE p.created_at >= $1 AND p.created_at < $2 AND p.id IN (${FAILED}))::int AS failed,
              count(*) FILTER (WHERE p.status = 'refunded' AND p.refunded_at >= $1 AND p.refunded_at < $2)::int AS refunded,
              coalesce(sum(p.amount_paise) FILTER (WHERE p.status = 'paid' AND p.paid_at >= $1 AND p.paid_at < $2), 0)::int AS gross_paise,
              coalesce(sum(p.amount_paise) FILTER (WHERE p.status = 'refunded' AND p.refunded_at >= $1 AND p.refunded_at < $2), 0)::int AS refunded_paise,
              count(DISTINCT p.user_id) FILTER (WHERE p.status = 'paid' AND p.paid_at >= $1 AND p.paid_at < $2)::int AS payers
         FROM payments p`, [r.from, r.to]),
    db.query(
      `SELECT to_char(date_trunc('${g}', p.paid_at AT TIME ZONE 'Asia/Kolkata'), '${gFmt}') AS label,
              count(*)::int AS payments, sum(p.amount_paise)::int AS gross_paise
         FROM payments p WHERE p.status = 'paid' AND p.paid_at >= $1 AND p.paid_at < $2
        GROUP BY 1 ORDER BY 1`, [r.from, r.to]),
    db.query(
      `SELECT ${SOURCE} AS source, count(*)::int AS payments, sum(p.amount_paise)::int AS gross_paise
         FROM payments p JOIN users u ON u.id = p.user_id
        WHERE p.status = 'paid' AND p.paid_at >= $1 AND p.paid_at < $2
        GROUP BY 1 ORDER BY 3 DESC`, [r.from, r.to]),
    db.query(
      `SELECT coalesce(e.metadata->>'method', 'not recorded') AS method, count(*)::int AS payments
         FROM events e WHERE e.name = 'payment_success' AND e.occurred_at >= $1 AND e.occurred_at < $2
        GROUP BY 1 ORDER BY 2 DESC`, [r.from, r.to]),
  ]);
  // The same split as the Command Center's, messaging included, so one period
  // shows one net wherever it is read.
  const [api, wa] = await Promise.all([
    db.one(`SELECT coalesce(sum(cost_paise), 0)::int AS c FROM api_calls WHERE created_at >= $1 AND created_at < $2`, [r.from, r.to]),
    db.one(`SELECT count(*)::int AS n FROM whatsapp_messages WHERE direction = 'out' AND message_type = 'template'
             AND created_at >= $1 AND created_at < $2`, [r.from, r.to]),
  ]);
  const money = await splitOf(n.gross_paise, { whatsapp: wa.n });
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    range: { label: r.label, from: r.from, to: r.to },
    totals: {
      ...n,
      success_pct: pct(n.started_paid, n.started),
      failure_pct: pct(n.failed, n.started),
      arpu_paise: n.payers ? Math.round(n.gross_paise / n.payers) : null,
      gst_paise: money.gst_paise,
      gateway_paise: money.gateway_fee_paise + money.gateway_fee_gst_paise,
      messaging_paise: money.whatsapp_cost_paise + money.sms_cost_paise,
      api_cost_paise: api.c,
      net_paise: money.take_home_paise - api.c,
    },
    series: series.rows, grain: q.grain in GRAINS ? q.grain : 'day',
    by_source: bySource.rows, by_method: byMethod.rows,
  };
}

const STATUS = {
  paid: `p.status = 'paid'`,
  pending: `p.status = 'created' AND p.created_at >= now() - interval '30 minutes'`,
  not_completed: `p.status = 'created' AND p.created_at < now() - interval '30 minutes'`,
  failed: `p.id IN (${FAILED})`,
  refunded: `p.status = 'refunded'`,
};

/** A payment's own money: GST, gateway, and the records calls behind it. */
async function split(p) {
  const m = await splitOf(p.status === 'paid' ? p.amount_paise : 0);
  const api = Number(p.api_cost_paise || 0);
  return {
    gst_paise: m.gst_paise,
    gateway_paise: m.gateway_fee_paise + m.gateway_fee_gst_paise,
    api_cost_paise: api,
    net_paise: p.status === 'paid' ? p.amount_paise - m.gst_paise - m.gateway_fee_paise - m.gateway_fee_gst_paise - api : 0,
  };
}

const ROW = `
  SELECT p.id, p.created_at, p.paid_at, p.refunded_at, p.status, p.amount_paise, p.gateway,
         p.order_id, p.payment_id AS razorpay_payment_id, p.refund_id,
         u.id AS user_id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS person_name,
         v.reg_no, pl.code AS plan_code,
         ${SOURCE} AS source,
         (SELECT e.metadata->>'method' FROM events e WHERE e.name = 'payment_success' AND e.payment_id = p.id LIMIT 1) AS method,
         p.id IN (${FAILED}) AS had_failure,
         -- The records calls for this vehicle by this customer in the day before paying.
         (SELECT coalesce(sum(a.cost_paise), 0) FROM api_calls a
           WHERE a.user_id = p.user_id AND a.vehicle_id = v.id
             AND a.created_at BETWEEN coalesce(p.paid_at, p.created_at) - interval '1 day' AND coalesce(p.paid_at, p.created_at)) AS api_cost_paise
    FROM payments p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN vehicles v ON v.id = (p.raw->>'vehicle_id')::bigint
    LEFT JOIN plans pl ON pl.id = p.plan_id`;

const label = (p) => (p.status === 'paid' ? 'Success' : p.status === 'refunded' ? 'Refunded'
  : p.had_failure ? 'Failed' : Date.now() - new Date(p.created_at) < 30 * 60000 ? 'Pending' : 'Not completed');

async function list(q = {}) {
  const r = command.resolve(q);
  const term = String(q.q || '').trim();
  const { rows } = await db.query(
    `SELECT * , count(*) OVER () AS total FROM (${ROW}
      WHERE p.created_at >= $1 AND p.created_at < $2
        AND (${STATUS[q.status] || 'true'})
        AND ($3 = '' OR u.mobile LIKE '%' || regexp_replace($3, '\\D', '', 'g') || '%'
             OR v.reg_no LIKE '%' || upper(regexp_replace($3, '[^A-Za-z0-9]', '', 'g')) || '%'
             OR p.order_id = $3 OR p.payment_id = $3)
    ) x ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
    [r.from, r.to, term, Math.min(200, Number(q.limit) || 25), Number(q.offset) || 0]);
  const out = [];
  for (const { total, ...p } of rows) out.push({ ...p, id: String(p.id), status_label: label(p), ...(await split(p)) });
  return { total: rows[0] ? Number(rows[0].total) : 0, rows: out };
}

async function detail(id) {
  if (!/^\d+$/.test(String(id))) return null;
  const p = await db.one(`${ROW} WHERE p.id = $1`, [id]);
  if (!p) return null;
  const [events, hooks, report, invoice] = await Promise.all([
    db.query(`SELECT occurred_at, name, channel, status, amount_paise, metadata FROM events WHERE payment_id = $1 ORDER BY occurred_at`, [id]),
    db.query(`SELECT created_at, detail->>'event' AS event, detail->>'status' AS status, detail->>'payment_id' AS razorpay_payment_id
                FROM event_log WHERE kind = 'razorpay_webhook'
                 AND (detail->>'reference_id' = $1 OR detail->>'reference_id' LIKE $2)
               ORDER BY id`, [`gp-${id}`, `gp-${id}-%`]),
    db.one(`SELECT id, report_number, created_at, valid_until FROM vehicle_reports WHERE payment_id = $1`, [id]),
    db.one(`SELECT id, invoice_number, created_at FROM invoices WHERE payment_id = $1`, [id]).catch(() => null),
  ]);
  return { ...p, id: String(p.id), status_label: label(p), ...(await split(p)),
           events: events.rows, webhooks: hooks.rows, report, invoice };
}

module.exports = { summary, list, detail };
