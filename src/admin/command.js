/**
 * src/admin/command.js — the Live Command Center's numbers (user, 2026-09-25).
 * ---------------------------------------------------------------------------
 *   overview(range)  every KPI for a period, against the period before, with a
 *                    sparkline; the whole journey as a funnel; profitability
 *   live(since)      what is happening right now, and the newest events
 *   drill(what)      the rows behind any number, so every figure can be opened
 *
 * Everything is read from `events` (migration 067), api_calls and payments —
 * real data only. A stage that cannot happen (the website no longer takes a
 * vehicle number) is returned as null with a reason, never as an invented 0.
 *
 * Money is worked out here, never in the browser: gross from completed
 * payments, then splitOf() for GST, the gateway fee and its GST and messaging,
 * then the Government-records API cost from api_calls.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const ledger = require('../finance/ledger');

const IST_MIN = 330;                       // India is UTC+5:30, all year
const DAY = 24 * 3600 * 1000;

/* ─────────────────────────────── periods ─────────────────────────────── */

/** Midnight IST of the day containing `t`, as a real instant. */
function istMidnight(t) {
  const ist = new Date(t.getTime() + IST_MIN * 60000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_MIN * 60000);
}
function istMonthStart(t, add = 0) {
  const ist = new Date(t.getTime() + IST_MIN * 60000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + add, 1) - IST_MIN * 60000);
}
const parseDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
  ? new Date(Date.parse(`${s}T00:00:00Z`) - IST_MIN * 60000) : null);

/* Quarters and India's financial year (April–March) — for finance and GST (operations module). */
function istQuarterStart(t, add = 0) {
  const ist = new Date(t.getTime() + IST_MIN * 60000);
  const q = Math.floor(ist.getUTCMonth() / 3) + add;
  return new Date(Date.UTC(ist.getUTCFullYear(), q * 3, 1) - IST_MIN * 60000);
}
function istFyStart(t, add = 0) {
  const ist = new Date(t.getTime() + IST_MIN * 60000);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return new Date(Date.UTC(y + add, 3, 1) - IST_MIN * 60000);
}

const PRESETS = ['today', 'yesterday', '7d', '30d', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_fy', 'last_fy', 'custom'];
const COMPARES = ['previous', 'yesterday', 'last_week', 'last_month', 'none'];

/**
 * The period asked for, and the one it is compared with. `to` is exclusive and,
 * for a period that includes today, is now — so "today" against "yesterday"
 * compares the same hours, not a whole day with part of one.
 */
function resolve({ range = 'today', from, to, compare = 'previous' } = {}) {
  const now = new Date();
  const today = istMidnight(now);
  let a; let b; let label;
  switch (PRESETS.includes(range) ? range : 'today') {
    case 'yesterday': a = new Date(today - DAY); b = today; label = 'Yesterday'; break;
    case '7d': a = new Date(today - 6 * DAY); b = now; label = 'Last 7 days'; break;
    case '30d': a = new Date(today - 29 * DAY); b = now; label = 'Last 30 days'; break;
    case 'this_month': a = istMonthStart(now); b = now; label = 'This month'; break;
    case 'last_month': a = istMonthStart(now, -1); b = istMonthStart(now); label = 'Last month'; break;
    case 'this_quarter': a = istQuarterStart(now); b = now; label = 'This quarter'; break;
    case 'last_quarter': a = istQuarterStart(now, -1); b = istQuarterStart(now); label = 'Last quarter'; break;
    case 'this_fy': a = istFyStart(now); b = now; label = 'This financial year'; break;
    case 'last_fy': a = istFyStart(now, -1); b = istFyStart(now); label = 'Last financial year'; break;
    case 'custom': {
      const f = parseDay(from); const t = parseDay(to);
      if (f && t && t >= f) { a = f; b = new Date(Math.min(t.getTime() + DAY, now.getTime())); label = `${from} → ${to}`; break; }
    } // fall through: a bad custom range is today
    // eslint-disable-next-line no-fallthrough
    default: a = today; b = now; label = 'Today';
  }
  const span = b - a;
  let pa = null; let pb = null; let cLabel = null;
  switch (COMPARES.includes(compare) ? compare : 'previous') {
    case 'none': break;
    case 'yesterday': pa = new Date(a - DAY); pb = new Date(b - DAY); cLabel = 'vs the day before'; break;
    case 'last_week': pa = new Date(a - 7 * DAY); pb = new Date(b - 7 * DAY); cLabel = 'vs the same days last week'; break;
    case 'last_month': {
      const shift = a - istMonthStart(a, -1);
      pa = new Date(a - shift); pb = new Date(b - shift); cLabel = 'vs the same days last month'; break;
    }
    // The period before, shifted by whole days so hours line up: "today so
    // far" against yesterday up to the same time, a week against the week before.
    default: {
      const days = Math.max(1, Math.ceil(span / DAY));
      pa = new Date(a - days * DAY); pb = new Date(b - days * DAY);
      cLabel = days === 1 ? 'vs the day before' : `vs the ${days} days before`;
    }
  }
  // Hours for a day or two; days beyond that.
  const step = span <= 2 * DAY ? 'hour' : 'day';
  return { from: a, to: b, prevFrom: pa, prevTo: pb, label, compareLabel: cLabel, step, range, compare };
}

/* ──────────────────────────────── metrics ─────────────────────────────── */

/*
 * One person, whichever way an event names them: its mobile, else the mobile
 * of its customer, else — on the website, before they write — the browser.
 */
const PERSON = `coalesce(e.mobile, u.mobile, 'web:' || e.visitor_id)`;

/** Every count the KPI cards need, for [from, to). */
/*
 * THE WEBSITE'S FIGURES (user, 2026-10-07: WhatsApp is retired, and "every
 * increase, decrease and percentage must compare the website — the ads").
 * Visits and pages from the website's events; vehicle checks from event_log —
 * the free chat checks and the signed-in website checks; reports, payments and
 * money from website payments only (finance/ledger.js, channel 'website').
 */
const WEB_EVENTS = `
  count(DISTINCT e.visitor_id) FILTER (WHERE e.channel = 'web')                         AS visitors,
  count(DISTINCT e.session_id) FILTER (WHERE e.name = 'session_started')                AS visits,
  count(*) FILTER (WHERE e.name = 'page_view')                                          AS page_views,
  count(*) FILTER (WHERE e.name = 'payment_page_viewed')                                AS pay_views`;
const WEB_CHECK = `(kind = 'chat_anon_check' OR (kind IN ('vehicle_check', 'vehicle_check_repeat') AND detail->>'channel' = 'web'))`;
const WEB_CHECKS = `
  count(*) FILTER (WHERE ${WEB_CHECK})                                                  AS searches,
  count(*) FILTER (WHERE ${WEB_CHECK} AND coalesce(detail->>'found', 'true') <> 'false') AS retrieved,
  count(*) FILTER (WHERE kind = 'site_sign_in')                                         AS sign_ins`;
const WEB_PAY = `coalesce(p.raw->>'channel', p.raw->'paid_from'->>'channel', 'whatsapp') = 'web'`;

async function totals(from, to) {
  const [ev, ck, rp, api, money] = await Promise.all([
    db.one(`SELECT ${WEB_EVENTS} FROM events e WHERE e.occurred_at >= $1 AND e.occurred_at < $2`, [from, to]),
    db.one(`SELECT ${WEB_CHECKS} FROM event_log WHERE created_at >= $1 AND created_at < $2
              AND kind IN ('chat_anon_check', 'vehicle_check', 'vehicle_check_repeat', 'site_sign_in')`, [from, to]),
    db.one(`SELECT count(*)::int AS reports FROM vehicle_reports r JOIN payments p ON p.id = r.payment_id
             WHERE r.created_at >= $1 AND r.created_at < $2 AND ${WEB_PAY}`, [from, to]),
    db.one(`SELECT coalesce(sum(cost_paise), 0)::int AS api_cost_paise, count(*)::int AS api_calls
              FROM api_calls WHERE created_at >= $1 AND created_at < $2`, [from, to]),
    ledger.periodMoney(from, to, null, { channel: 'website' }),
  ]);
  const n = Object.fromEntries(Object.entries({ ...ev, ...ck, ...rp }).map(([k, v]) => [k, Number(v || 0)]));
  return {
    ...n,
    paid: money.payments,
    revenue_paise: money.gross_paise,
    api_cost_paise: money.api_cost_total_paise,
    api_calls: api.api_calls,
    gst_paise: money.gst_paise,
    gateway_paise: money.gateway_paise,
    messaging_paise: money.messaging_paise,
    refund_paise: money.refund_paise,
    net_paise: money.net_paise,
  };
}

/** The same website figures per hour or per day, for the sparklines. */
async function series(from, to, step) {
  const { rows } = await db.query(
    `WITH b AS (
       SELECT t, t + $3::interval AS t2 FROM generate_series($1::timestamptz, $2::timestamptz - interval '1 second', $3::interval) t
     )
     SELECT b.t,
            to_char(b.t AT TIME ZONE 'Asia/Kolkata', $4) AS label,
            (SELECT count(DISTINCT e.visitor_id) FILTER (WHERE e.channel = 'web') FROM events e WHERE e.occurred_at >= b.t AND e.occurred_at < b.t2) AS visitors,
            (SELECT count(DISTINCT e.session_id) FILTER (WHERE e.name = 'session_started') FROM events e WHERE e.occurred_at >= b.t AND e.occurred_at < b.t2) AS visits,
            (SELECT count(*) FILTER (WHERE e.name = 'page_view') FROM events e WHERE e.occurred_at >= b.t AND e.occurred_at < b.t2) AS page_views,
            (SELECT count(*) FILTER (WHERE e.name = 'payment_page_viewed') FROM events e WHERE e.occurred_at >= b.t AND e.occurred_at < b.t2) AS pay_views,
            (SELECT count(*) FROM event_log WHERE created_at >= b.t AND created_at < b.t2 AND ${WEB_CHECK}) AS searches,
            (SELECT count(*) FROM event_log WHERE created_at >= b.t AND created_at < b.t2 AND ${WEB_CHECK}
                AND coalesce(detail->>'found', 'true') <> 'false') AS retrieved,
            (SELECT count(*) FROM event_log WHERE created_at >= b.t AND created_at < b.t2 AND kind = 'site_sign_in') AS sign_ins,
            (SELECT count(*) FROM vehicle_reports r JOIN payments p ON p.id = r.payment_id
              WHERE r.created_at >= b.t AND r.created_at < b.t2 AND ${WEB_PAY}) AS reports,
            (SELECT coalesce(sum(cost_paise), 0) FROM api_calls a WHERE a.created_at >= b.t AND a.created_at < b.t2) AS api_cost_paise
       FROM b ORDER BY b.t`,
    [from, to, step === 'hour' ? '1 hour' : '1 day', step === 'hour' ? 'HH24:00' : 'DD Mon']);
  // Each bucket's payments, revenue and net from the ledger's own website payments,
  // less that bucket's API calls — the same arithmetic as the period's total.
  const { rows: all } = await ledger.entries({ from, to });
  const pays = all.filter((p) => p.channel === 'website');
  const out = [];
  for (const r of rows) {
    const n = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'label' || k === 't' ? v : Number(v || 0)]));
    const t0 = new Date(r.t).getTime(); const t1 = t0 + (step === 'hour' ? 3600e3 : 86400e3);
    const mine = pays.filter((p) => { const at = new Date(p.paid_at || p.created_at).getTime(); return at >= t0 && at < t1; });
    const kept = mine.reduce((a, p) => a + p.net_revenue_paise - p.gateway_fee_paise - p.gateway_gst_paise, 0);
    const paidRows = mine.filter((p) => p.status === 'paid' || p.paid_at);
    out.push({ ...n, paid: paidRows.length, revenue_paise: paidRows.reduce((a, p) => a + (p.gross_paise ?? p.amount_paise ?? 0), 0),
      net_paise: kept - n.api_cost_paise });
  }
  return out;
}

/*
 * The KPI cards: what each one counts, in words a person can check against
 * the rows behind it. `worse_up` flips the colour for costs. `drill` names the
 * events a click opens.
 */
const KPIS = [
  ['visitors', 'Website visitors', 'Different browsers that opened gaadipe.in.', { drill: 'web' }],
  ['visits', 'Website visits', 'Visits started — one browser can visit more than once.', { drill: 'session_started' }],
  ['searches', 'Vehicle checks', 'Vehicle numbers checked on the website — free checks in the chat and signed-in checks.', {}],
  ['retrieved', 'Vehicle details shown', 'Checks that found the vehicle and showed its details.', {}],
  ['sign_ins', 'Sign-ins', 'Customers who signed in on the website with their mobile number.', {}],
  ['pay_views', 'Payment page views', 'Checkout pages opened while unpaid — once per payment.', { drill: 'payment_page_viewed' }],
  ['paid', 'Successful payments', 'Website payments that completed.', { drill: 'payment_success' }],
  ['revenue_paise', 'Revenue', 'Money received on the website, GST included — what customers paid.', { money: true, drill: 'payment_success' }],
  ['reports', 'Reports generated', 'Full reports (PDF) produced for website payments.', { drill: 'report_generated' }],
  ['api_cost_paise', 'API cost', 'What the Government-records calls cost, from api_calls.', { money: true, worse_up: true, drill: 'api' }],
  ['net_paise', 'Net contribution', 'Website revenue after GST, the payment gateway fee and its GST, SMS and the API cost.', { money: true }],
];

async function overview(q = {}) {
  const r = resolve(q);
  const [cur, prev, spark] = await Promise.all([
    totals(r.from, r.to),
    r.prevFrom ? totals(r.prevFrom, r.prevTo) : null,
    series(r.from, r.to, r.step),
  ]);
  const kpis = KPIS.map(([key, label, note, o]) => {
    const now = cur[key]; const before = prev ? prev[key] : null;
    return {
      key, label, note, money: !!o.money, worse_up: !!o.worse_up, drill: o.drill || null,
      value: now, previous: before,
      change: before == null ? null : now - before,
      change_pct: before == null || before === 0 ? null : Math.round(((now - before) / before) * 1000) / 10,
      spark: spark.map((s) => s[key] ?? 0),
    };
  });
  return {
    range: { label: r.label, from: r.from, to: r.to, step: r.step, preset: r.range },
    compare: r.prevFrom ? { label: r.compareLabel, from: r.prevFrom, to: r.prevTo, preset: r.compare } : null,
    kpis,
    money: {
      gross_paise: cur.revenue_paise, gst_paise: cur.gst_paise, gateway_paise: cur.gateway_paise,
      messaging_paise: cur.messaging_paise, api_cost_paise: cur.api_cost_paise, net_paise: cur.net_paise,
      previous_net_paise: prev ? prev.net_paise : null,
    },
    labels: spark.map((s) => s.label),
    funnel: await funnel(r),
    at: new Date().toISOString(),
  };
}

/* ───────────────────────────────── funnel ──────────────────────────────── */

/*
 * THE WEBSITE'S JOURNEY (2026-10-07: WhatsApp is retired). One visit per stage,
 * in order — the same stages as the website analytics (admin/analytics.js):
 * visited → checked a vehicle → saw it → tapped Full report → payment started →
 * paid → report. A later stage implies the earlier ones.
 */
const STAGES = [
  ['visited', 'Website visit'], ['searched', 'Checked a vehicle'], ['saw', 'Saw the vehicle'],
  ['cta', 'Tapped Full report'], ['pay_started', 'Payment started'], ['paid', 'Payment completed'],
  ['report', 'Report generated'],
];

async function stageCounts(from, to) {
  const visits = await require('./analytics').perVisit({ from, to });
  return Object.fromEntries(STAGES.map(([key]) => [key, visits.filter((v) => v.at[key]).length]));
}

async function funnel(r) {
  const [cur, prev] = await Promise.all([
    stageCounts(r.from, r.to),
    r.prevFrom ? stageCounts(r.prevFrom, r.prevTo) : null,
  ]);
  let last = null; let lastLabel = null;
  return STAGES.map(([key, label]) => {
    const n = Number(cur[key] || 0);
    const base = last; const baseLabel = lastLabel;
    if (n) { last = n; lastLabel = label; }
    return {
      key, label, n, previous: prev ? Number(prev[key] || 0) : null,
      unavailable: null,
      conversion_pct: !base ? null : Math.round((n / base) * 1000) / 10,
      drop_pct: !base ? null : Math.max(0, Math.round(((base - n) / base) * 1000) / 10),
      from_stage: base ? baseLabel : null,
      drill: key === 'visited' ? 'stage:visited' : null,
    };
  });
}

/* ────────────────────────────────── live ───────────────────────────────── */

const FEED_WORDS = {
  session_started: 'Visit started', page_view: 'Page viewed', whatsapp_cta_clicked: 'WhatsApp button clicked',
  whatsapp_chat_started: 'New WhatsApp chat', whatsapp_message_received: 'WhatsApp message',
  whatsapp_greeting: 'Said Hi', terms_accepted: 'Agreed to terms', whatsapp_vehicle_received: 'Vehicle number sent',
  vehicle_api_success: 'Records API ok', vehicle_api_failed: 'Records API failed',
  vehicle_search_success: 'Vehicle details shown', vehicle_search_failed: 'Vehicle not found',
  report_preview_viewed: 'Tapped full report', payment_started: 'Payment link sent',
  payment_page_viewed: 'Payment page opened', payment_success: 'Payment received',
  report_generated: 'Report generated', report_delivered: 'Report delivered',
  whatsapp_linked_to_web: 'Chat linked to website visit', whatsapp_ad_clicked: 'Came from a WhatsApp ad',
  whatsapp_opt_out: 'Replied STOP', whatsapp_opt_in: 'Replied START', whatsapp_reminder_sent: 'Reminder sent',
};

async function live({ since = null } = {}) {
  const sinceId = /^\d+$/.test(String(since || '')) ? String(since) : null;
  const [feed, now] = await Promise.all([
    db.query(
      `SELECT e.id, e.occurred_at, e.name, e.channel, e.mobile, u.mobile AS user_mobile,
              coalesce(u.display_name, u.wa_profile_name) AS person_name,
              e.visitor_id, e.reg_no, e.amount_paise, e.status, e.source, e.page, e.duration_ms
         FROM events e LEFT JOIN users u ON u.id = e.user_id
        WHERE ($1::bigint IS NULL OR e.id > $1::bigint)
          -- Every page view would drown the rest; the visit start stands for them.
          AND e.name <> 'page_view'
        ORDER BY e.id DESC LIMIT 40`, [sinceId]),
    db.one(
      `SELECT
         count(DISTINCT visitor_id) FILTER (WHERE channel = 'web' AND occurred_at > now() - interval '5 minutes')::int  AS on_site,
         count(*) FILTER (WHERE name = 'payment_success' AND occurred_at > now() - interval '60 minutes')::int AS paid_hour,
         count(*) FILTER (WHERE name IN ('vehicle_api_failed') AND occurred_at > now() - interval '15 minutes')::int AS api_errors,
         count(*) FILTER (WHERE name = 'report_delivered' AND status <> 'ok' AND occurred_at > now() - interval '60 minutes')::int AS delivery_errors
       FROM events WHERE occurred_at > now() - interval '60 minutes'`),
  ]);
  const paying = await db.one(
    `SELECT count(*)::int AS n FROM payments
      WHERE status = 'created' AND created_at > now() - interval '30 minutes'`);
  /*
   * Checks and sign-ins in the last 15 minutes. WhatsApp is back (2026-10-09):
   * the main admin (X-View: whatsapp, admin/consented.js) counts WhatsApp checks,
   * the web admin the website's. A WhatsApp check is saved without a channel.
   */
  const consented = require('./consented');
  const waView = consented.view.getStore()?.whatsappOnly === true;
  const WA_CHECK = `(kind IN ('vehicle_check', 'vehicle_check_repeat') AND coalesce(detail->>'channel', 'whatsapp') = 'whatsapp')`;
  const web = await db.one(
    `SELECT count(*) FILTER (WHERE ${waView ? WA_CHECK : WEB_CHECK})::int AS searches,
            count(DISTINCT detail->>'mobile') FILTER (WHERE kind = 'site_sign_in')::int AS signing_in
       FROM event_log WHERE created_at > now() - interval '15 minutes'
        AND kind IN ('chat_anon_check', 'vehicle_check', 'vehicle_check_repeat', 'site_sign_in')`);
  now.searches = web.searches; now.signing_in = web.signing_in;
  // "Chatting": people who wrote on WhatsApp in the last 15 minutes — only those who agreed (and never STOP).
  now.chatting = (await db.one(
    `SELECT count(*)::int AS n FROM whatsapp_sessions s
      WHERE s.last_inbound_at > now() - interval '15 minutes' AND ${consented.agreedSql('s.mobile')}`)).n;
  const errors = now.api_errors + now.delivery_errors;
  return {
    status: errors ? { level: 'degraded', text: `${errors} error${errors === 1 ? '' : 's'} in the last hour` }
      : { level: 'operational', text: 'All systems normal' },
    counters: { ...now, paying_now: paying.n },
    events: feed.rows.reverse().map((e) => ({
      ...e, id: String(e.id), mobile: e.mobile || e.user_mobile || null,
      words: FEED_WORDS[e.name] || e.name.replace(/_/g, ' '),
    })),
    last_id: feed.rows[0] ? String(feed.rows[0].id) : (sinceId || null),
    at: new Date().toISOString(),
  };
}

/* ───────────────────────────────── drill ───────────────────────────────── */

/* What a click opens: a KPI's drill name or a funnel stage, as event names. */
function namesFor(what) {
  if (what === 'web') return { web: true };
  if (what === 'searches') return { names: ['vehicle_search_success', 'vehicle_search_failed'] };
  if (what === 'api') return { names: ['vehicle_api_success', 'vehicle_api_failed'] };
  // The website funnel: its first stage opens the website's events (the visits behind each stage are on /web/analytics).
  if (String(what).startsWith('stage:')) return what === 'stage:visited' ? { web: true } : null;
  return /^[a-z_]{3,60}$/.test(String(what)) ? { names: [what] } : null;
}

async function drill({ what, range, from, to, compare, previous = false, limit = 200 } = {}) {
  const sel = namesFor(what);
  if (!sel) return { rows: [], total: 0 };
  const r = resolve({ range, from, to, compare });
  const a = previous && r.prevFrom ? r.prevFrom : r.from;
  const b = previous && r.prevTo ? r.prevTo : r.to;
  const { rows } = await db.query(
    `SELECT e.id, e.occurred_at, e.name, e.channel, coalesce(e.mobile, u.mobile) AS mobile,
            coalesce(u.display_name, u.wa_profile_name) AS person_name, e.user_id, e.visitor_id,
            e.reg_no, e.payment_id, e.amount_paise, e.status, e.error_code, e.duration_ms,
            e.source, e.campaign, e.page, e.metadata,
            count(*) OVER () AS total
       FROM events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.occurred_at >= $1 AND e.occurred_at < $2
        AND (${sel.web ? `e.channel = 'web'` : `e.name = ANY($3::text[])`})
      ORDER BY e.occurred_at DESC LIMIT $4`,
    sel.web ? [a, b, [], Math.min(1000, limit)] : [a, b, sel.names, Math.min(1000, limit)]);
  return {
    period: { from: a, to: b },
    total: rows[0] ? Number(rows[0].total) : 0,
    rows: rows.map(({ total, ...e }) => ({
      ...e, id: String(e.id), user_id: e.user_id ? String(e.user_id) : null,
      payment_id: e.payment_id ? String(e.payment_id) : null,
      words: FEED_WORDS[e.name] || e.name.replace(/_/g, ' '),
    })),
  };
}

module.exports = { overview, live, drill, resolve, totals, PRESETS, COMPARES };
