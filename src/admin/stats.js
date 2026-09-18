/**
 * src/admin/stats.js — the numbers the panel opens on, and the money behind them.
 *
 * EVERY DATE IS IST. A day in this business ends at midnight in India, not at
 * midnight UTC, and a dashboard that disagrees with the owner's own sense of
 * "today" is worse than no dashboard. So every grouping goes through
 * `AT TIME ZONE 'Asia/Kolkata'`, once, here.
 *
 * TURNOVER IS NOT INCOME. Prices are GST-inclusive, Razorpay keeps a cut, and
 * ULIP will one day charge per lookup. The panel therefore reports the whole
 * chain — gross, the GST inside it, the gateway's fee and its GST, what ULIP
 * cost — and take-home at the end of it. A screen that shows ₹19 × 100 = ₹1,900
 * and stops is telling the owner something untrue.
 */

const db = require('../db');
const settings = require('../util/settings');

/* Any timestamp grouped or filtered by day is converted once, this way. */
const IST = `AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'`;

const GRAIN = { day: 'day', week: 'week', month: 'month' };

/** What the gateway and the taxman take out of a gross amount. */
async function splitOf(grossPaise) {
  const feePct = await settings.num('razorpay_fee_percent', 2);
  const feeGstPct = await settings.num('razorpay_fee_gst_percent', 18);

  const gross = Number(grossPaise || 0);
  const taxable = Math.round(gross / 1.18);
  const gst = gross - taxable;
  const fee = Math.round(gross * (feePct / 100));
  const feeGst = Math.round(fee * (feeGstPct / 100));

  return {
    gross_paise: gross,
    taxable_paise: taxable,
    gst_paise: gst,
    gateway_fee_paise: fee,
    gateway_fee_gst_paise: feeGst,
    // What is actually left once GST is remitted and the gateway is paid.
    take_home_paise: gross - gst - fee - feeGst,
    fee_percent: feePct,
  };
}

/**
 * The opening screen: today against yesterday, and the totals that never reset.
 * One round trip — a dashboard that makes twelve calls feels broken on a phone.
 */
async function dashboard() {
  const row = await db.one(
    `WITH bounds AS (
       SELECT date_trunc('day', now() ${IST}) AS today,
              date_trunc('day', now() ${IST}) - interval '1 day' AS yesterday
     )
     SELECT
       (SELECT count(*) FROM users)                                        AS users_total,
       (SELECT count(*) FROM users u, bounds b
         WHERE u.created_at ${IST} >= b.today)                             AS users_today,
       (SELECT count(*) FROM users u, bounds b
         WHERE u.created_at ${IST} >= b.yesterday
           AND u.created_at ${IST} < b.today)                              AS users_yesterday,
       (SELECT count(*) FROM vehicles)                                     AS vehicles_total,
       (SELECT count(*) FROM event_log e, bounds b
         WHERE e.kind = 'vehicle_check' AND e.created_at ${IST} >= b.today) AS checks_today,
       (SELECT count(*) FROM event_log e, bounds b
         WHERE e.kind = 'vehicle_check' AND e.created_at ${IST} >= b.yesterday
           AND e.created_at ${IST} < b.today)                              AS checks_yesterday,
       (SELECT count(*) FROM payments p WHERE p.status = 'paid')           AS payments_total,
       (SELECT coalesce(sum(amount_paise), 0) FROM payments WHERE status = 'paid') AS gross_total_paise,
       (SELECT coalesce(sum(amount_paise), 0) FROM payments p, bounds b
         WHERE p.status = 'paid' AND p.paid_at ${IST} >= b.today)          AS gross_today_paise,
       (SELECT count(*) FROM payments p, bounds b
         WHERE p.status = 'paid' AND p.paid_at ${IST} >= b.today)          AS payments_today,
       (SELECT count(*) FROM payments p, bounds b
         WHERE p.status = 'paid' AND p.paid_at ${IST} >= b.yesterday
           AND p.paid_at ${IST} < b.today)                                 AS payments_yesterday,
       (SELECT coalesce(sum(amount_paise), 0) FROM payments p, bounds b
         WHERE p.status = 'paid' AND p.paid_at ${IST} >= b.yesterday
           AND p.paid_at ${IST} < b.today)                                 AS gross_yesterday_paise,
       (SELECT count(*) FROM payments WHERE status = 'created'
          AND created_at > now() - interval '24 hours')                    AS payments_pending,
       (SELECT count(*) FROM watches WHERE is_active)                      AS watches_active,
       (SELECT count(*) FROM subscriptions
         WHERE is_active AND ends_on >= CURRENT_DATE)                      AS subscriptions_active,
       (SELECT count(*) FROM vehicle_reports)                              AS reports_total,
       (SELECT count(*) FROM vehicle_reports r, bounds b
         WHERE r.created_at ${IST} >= b.today)                             AS reports_today,
       (SELECT count(*) FROM whatsapp_messages m, bounds b
         WHERE m.created_at ${IST} >= b.today)                             AS messages_today,
       (SELECT count(*) FROM whatsapp_messages m, bounds b
         WHERE m.direction = 'out' AND m.error_message IS NOT NULL
           AND m.created_at ${IST} >= b.today)                             AS send_failures_today,
       (SELECT count(*) FROM whatsapp_sessions
         WHERE last_inbound_at > now() - interval '24 hours')              AS in_window,
       (SELECT count(*) FROM api_calls a, bounds b
         WHERE NOT a.cache_hit AND a.created_at ${IST} >= b.today)         AS ulip_calls_today,
       (SELECT count(*) FROM api_calls a, bounds b
         WHERE a.cache_hit AND a.created_at ${IST} >= b.today)             AS cache_hits_today,
       (SELECT count(*) FROM blocks WHERE released_at IS NULL)             AS blocks_active,
       (SELECT count(*) FROM feedback)                                     AS feedback_total`);

  const money = await splitOf(row.gross_total_paise);
  const todayMoney = await splitOf(row.gross_today_paise);

  const n = (v) => Number(v || 0);
  return {
    users: { total: n(row.users_total), today: n(row.users_today), yesterday: n(row.users_yesterday) },
    checks: { today: n(row.checks_today), yesterday: n(row.checks_yesterday) },
    vehicles: { total: n(row.vehicles_total) },
    payments: {
      total: n(row.payments_total), today: n(row.payments_today),
      yesterday: n(row.payments_yesterday), pending: n(row.payments_pending),
    },
    money: { all_time: money, today: todayMoney,
             gross_yesterday_paise: n(row.gross_yesterday_paise) },
    watching: { watches: n(row.watches_active), subscriptions: n(row.subscriptions_active) },
    reports: { total: n(row.reports_total), today: n(row.reports_today) },
    whatsapp: { messages_today: n(row.messages_today),
                send_failures_today: n(row.send_failures_today),
                in_window: n(row.in_window) },
    ulip: { calls_today: n(row.ulip_calls_today), cache_hits_today: n(row.cache_hits_today) },
    blocks: n(row.blocks_active),
    feedback: n(row.feedback_total),
    as_of: new Date().toISOString(),
  };
}

/**
 * Day, week or month series for the graphs.
 *
 * Every bucket in the range is returned, including the empty ones:
 * generate_series is what stops a quiet Tuesday from disappearing and making a
 * line chart lie about the shape of the week.
 */
async function series({ grain = 'day', days = 30 } = {}) {
  const g = GRAIN[grain] || 'day';
  const span = Math.min(730, Math.max(1, Number(days) || 30));

  const { rows } = await db.query(
    `WITH buckets AS (
       SELECT generate_series(
         date_trunc('${g}', (now() ${IST}) - ($1 || ' days')::interval),
         date_trunc('${g}', now() ${IST}),
         ('1 ${g}')::interval) AS bucket
     )
     SELECT b.bucket,
       (SELECT count(*) FROM users u
         WHERE date_trunc('${g}', u.created_at ${IST}) = b.bucket)          AS new_users,
       (SELECT count(*) FROM event_log e
         WHERE e.kind = 'vehicle_check'
           AND date_trunc('${g}', e.created_at ${IST}) = b.bucket)          AS checks,
       (SELECT count(DISTINCT e.user_id) FROM event_log e
         WHERE e.kind = 'vehicle_check'
           AND date_trunc('${g}', e.created_at ${IST}) = b.bucket)          AS active_users,
       (SELECT count(*) FROM payments p
         WHERE p.status = 'paid'
           AND date_trunc('${g}', p.paid_at ${IST}) = b.bucket)             AS payments,
       (SELECT coalesce(sum(p.amount_paise), 0) FROM payments p
         WHERE p.status = 'paid'
           AND date_trunc('${g}', p.paid_at ${IST}) = b.bucket)             AS gross_paise,
       (SELECT coalesce(sum(p.amount_paise), 0) FROM payments p
         WHERE p.status = 'refunded'
           AND date_trunc('${g}', p.refunded_at ${IST}) = b.bucket)         AS refunded_paise,
       (SELECT count(*) FROM vehicle_reports r
         WHERE date_trunc('${g}', r.created_at ${IST}) = b.bucket)          AS reports,
       (SELECT count(*) FROM api_calls a
         WHERE NOT a.cache_hit
           AND date_trunc('${g}', a.created_at ${IST}) = b.bucket)          AS ulip_calls,
       (SELECT coalesce(sum(a.cost_paise), 0) FROM api_calls a
         WHERE date_trunc('${g}', a.created_at ${IST}) = b.bucket)          AS ulip_cost_paise,
       (SELECT count(*) FROM whatsapp_messages m
         WHERE date_trunc('${g}', m.created_at ${IST}) = b.bucket)          AS messages
       FROM buckets b ORDER BY b.bucket`, [String(span)]);

  const out = [];
  for (const r of rows) {
    const split = await splitOf(r.gross_paise);
    out.push({
      bucket: new Date(r.bucket).toISOString().slice(0, 10),
      new_users: Number(r.new_users), checks: Number(r.checks),
      active_users: Number(r.active_users), payments: Number(r.payments),
      reports: Number(r.reports), messages: Number(r.messages),
      ulip_calls: Number(r.ulip_calls), ulip_cost_paise: Number(r.ulip_cost_paise),
      refunded_paise: Number(r.refunded_paise),
      ...split,
    });
  }
  return { grain: g, days: span, rows: out };
}

/**
 * The money, in the order an accountant reads it, for a date range.
 * `by_plan` answers "which product earns", which is the whole question while
 * two products exist side by side.
 */
async function finance({ from = null, to = null } = {}) {
  const row = await db.one(
    `SELECT
       count(*) FILTER (WHERE status = 'paid')                       AS payments,
       coalesce(sum(amount_paise) FILTER (WHERE status = 'paid'), 0) AS gross_paise,
       count(*) FILTER (WHERE status = 'refunded')                   AS refunds,
       coalesce(sum(amount_paise) FILTER (WHERE status = 'refunded'), 0) AS refunded_paise,
       count(*) FILTER (WHERE status = 'created')                    AS abandoned
       FROM payments
      WHERE ($1::date IS NULL OR coalesce(paid_at, created_at) ${IST} >= $1::date)
        AND ($2::date IS NULL OR coalesce(paid_at, created_at) ${IST} < ($2::date + 1))`,
    [from, to]);

  const byPlan = await db.query(
    `SELECT coalesce(pl.code, 'unknown') AS plan_code, coalesce(pl.name, '—') AS plan_name,
            pl.kind AS plan_kind,
            count(*) AS payments, coalesce(sum(p.amount_paise), 0) AS gross_paise
       FROM payments p
       LEFT JOIN plans pl ON pl.id = p.plan_id
      WHERE p.status = 'paid'
        AND ($1::date IS NULL OR p.paid_at ${IST} >= $1::date)
        AND ($2::date IS NULL OR p.paid_at ${IST} < ($2::date + 1))
      GROUP BY 1, 2, 3 ORDER BY gross_paise DESC`, [from, to]);

  const gst = await db.query(
    `SELECT place_of_supply,
            count(*) AS invoices,
            coalesce(sum(base_paise), 0) AS taxable_paise,
            coalesce(sum(cgst_paise), 0) AS cgst_paise,
            coalesce(sum(sgst_paise), 0) AS sgst_paise,
            coalesce(sum(igst_paise), 0) AS igst_paise,
            coalesce(sum(total_paise), 0) AS total_paise
       FROM invoices
      WHERE ($1::date IS NULL OR invoice_date ${IST} >= $1::date)
        AND ($2::date IS NULL OR invoice_date ${IST} < ($2::date + 1))
      GROUP BY place_of_supply ORDER BY total_paise DESC`, [from, to]);

  const ulip = await db.one(
    `SELECT count(*) FILTER (WHERE NOT cache_hit) AS calls,
            count(*) FILTER (WHERE cache_hit)     AS cache_hits,
            coalesce(sum(cost_paise), 0)          AS cost_paise
       FROM api_calls
      WHERE ($1::date IS NULL OR created_at ${IST} >= $1::date)
        AND ($2::date IS NULL OR created_at ${IST} < ($2::date + 1))`, [from, to]);

  const split = await splitOf(row.gross_paise);
  const cost = Number(ulip.cost_paise || 0);

  return {
    range: { from, to },
    payments: Number(row.payments), refunds: Number(row.refunds),
    abandoned: Number(row.abandoned),
    refunded_paise: Number(row.refunded_paise),
    ...split,
    ulip: { calls: Number(ulip.calls), cache_hits: Number(ulip.cache_hits), cost_paise: cost },
    // After tax, gateway and data costs. The only figure that is really income.
    net_paise: split.take_home_paise - cost - Number(row.refunded_paise),
    by_plan: byPlan.rows.map(r => ({ ...r, payments: Number(r.payments),
                                     gross_paise: Number(r.gross_paise) })),
    gst_by_state: gst.rows,
  };
}

/**
 * The funnel, from "hi" to a payment.
 *
 * Counted by distinct mobile rather than by event, because the question is how
 * many PEOPLE fall out at each step — someone who sent four vehicle numbers is
 * one person who got that far, not four.
 */
async function funnel({ days = 30 } = {}) {
  const span = Math.min(365, Math.max(1, Number(days) || 30));
  const { rows } = await db.query(
    `SELECT detail->>'step' AS step, count(DISTINCT detail->>'mobile')::int AS people
       FROM event_log
      WHERE kind = 'funnel' AND created_at > now() - ($1 || ' days')::interval
      GROUP BY 1`, [String(span)]);

  const paid = await db.one(
    `SELECT count(DISTINCT u.mobile)::int AS people
       FROM payments p JOIN users u ON u.id = p.user_id
      WHERE p.status = 'paid' AND p.paid_at > now() - ($1 || ' days')::interval`, [String(span)]);

  const got = Object.fromEntries(rows.map(r => [r.step, r.people]));
  const ORDER = [
    ['hi', 'Said hi'],
    ['agreed', 'Agreed to terms'],
    ['number', 'Sent a vehicle number'],
    ['basic_shown', 'Saw the basic details'],
    ['buy_tapped', 'Tapped the full report'],
    ['link_sent', 'Got a payment link'],
  ];
  const steps = ORDER.map(([key, label]) => ({ key, label, people: got[key] || 0 }));
  steps.push({ key: 'paid', label: 'Paid', people: paid.people });

  const first = steps[0].people || 0;
  return {
    days: span,
    steps: steps.map(s => ({ ...s, of_first: first ? Math.round((s.people / first) * 100) : 0 })),
  };
}

module.exports = { dashboard, series, finance, funnel, splitOf };
