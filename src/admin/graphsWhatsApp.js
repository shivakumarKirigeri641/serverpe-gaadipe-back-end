/**
 * src/admin/graphsWhatsApp.js — the Graphs section for the WhatsApp admin
 * (user, 2026-10-09: "no webadmin concepts/contents in the WhatsApp admin";
 * "I don't see the graph moving in Graphs › Today live").
 *
 * On 7 Oct, with WhatsApp gone, admin/graphs.js was turned into the website's
 * graphs. The main admin's Graphs pages were never changed and still draw the
 * WhatsApp shapes — so with WhatsApp back they stood still. This is the 6 Oct
 * WhatsApp version again (commit f94d46e), for the main admin only (X-View:
 * whatsapp, admin/consented.js), with the 9 Oct rules:
 *
 *   - only people who agreed to the Terms ON WHATSAPP, never anyone who only
 *     said Hi, and never anyone who said STOP (as counts of STOP, not people)
 *   - WhatsApp checks and WhatsApp payments only — no website rows
 *   - the funnel starts at "Agreed"
 *
 * The web admin keeps admin/graphs.js. Read-only.
 */

const db = require('../db');
const settings = require('../util/settings');
const ledger = require('../finance/ledger');
const geo = require('./geo');
const { agreedSql } = require('./consented');

const IST = `AT TIME ZONE 'Asia/Kolkata'`;
const dayOf = (col) => `(${col} ${IST})::date`;
const span = (days) => [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

/* The period's days, oldest first, as $1 = number of days. */
const DAYS = `days AS (SELECT generate_series((now() ${IST})::date - ($1::int - 1), (now() ${IST})::date, interval '1 day')::date AS d)`;
const FROM = `((now() ${IST})::date - ($1::int - 1))`;
const since = (col) => `${col} >= (${FROM}::timestamp ${IST})`;

/* WhatsApp only: a WhatsApp check is saved without a channel; a website payment says so. */
const CHECKS = `kind IN ('vehicle_check', 'vehicle_check_repeat') AND coalesce(detail->>'channel', 'whatsapp') = 'whatsapp'`;
const PAID = `p.status = 'paid' AND p.amount_paise > 0
  AND coalesce(p.raw->>'channel', p.raw->'paid_from'->>'channel', 'whatsapp') NOT IN ('web', 'website')`;
const AGREED = (col) => agreedSql(col, { whatsappOnly: true });
/* When each customer first agreed on WhatsApp — "a new customer" — never anyone who said STOP. */
const FIRST = `SELECT right(regexp_replace(detail->>'mobile', '\\D', '', 'g'), 10) AS m, min(created_at) AS at
                 FROM event_log WHERE kind = 'consent_accepted' AND coalesce(detail->>'channel', 'whatsapp') = 'whatsapp'
                GROUP BY 1`;
const NOT_STOPPED = (col) => `NOT EXISTS (SELECT 1 FROM whatsapp_sessions so WHERE right(so.mobile, 10) = ${col} AND so.wa_opt_out_at IS NOT NULL)`;
const mask = (m) => (m ? `••••••${String(m).slice(-4)}` : null);

/* ─────────────────────────────── overview ─────────────────────────────── */

async function overview({ days }) {
  const n = span(days);
  const { rows } = await db.query(
    `WITH ${DAYS},
       u AS (SELECT ${dayOf('f.at')} AS d, count(*) AS n FROM (${FIRST}) f WHERE ${since('f.at')} AND ${NOT_STOPPED('f.m')} GROUP BY 1),
       c AS (SELECT ${dayOf('created_at')} AS d, count(*) AS n, count(DISTINCT detail->>'reg_no') AS distinct_n
               FROM event_log WHERE ${CHECKS} AND ${since('created_at')} GROUP BY 1),
       r AS (SELECT ${dayOf('r.created_at')} AS d, count(*) AS n FROM vehicle_reports r JOIN payments p ON p.id = r.payment_id
              WHERE ${PAID} AND ${since('r.created_at')} GROUP BY 1),
       m AS (SELECT ${dayOf('paid_at')} AS d, sum(amount_paise) AS paise FROM payments p WHERE ${PAID} AND ${since('paid_at')} GROUP BY 1)
     SELECT days.d, coalesce(u.n, 0)::int AS customers,
            coalesce(c.distinct_n, 0)::int AS checks_distinct, (coalesce(c.n, 0) - coalesce(c.distinct_n, 0))::int AS checks_repeat,
            coalesce(r.n, 0)::int AS reports, coalesce(m.paise, 0)::bigint AS revenue_paise
       FROM days LEFT JOIN u USING (d) LEFT JOIN c USING (d) LEFT JOIN r USING (d) LEFT JOIN m USING (d)
      ORDER BY days.d`, [n]);
  // The check speedometer: WhatsApp checks in the last hour against the busiest hour of 90 days.
  const pace = await db.one(
    `SELECT (SELECT count(*) FROM event_log WHERE ${CHECKS} AND created_at > now() - interval '1 hour')::int AS last_hour,
            (SELECT coalesce(max(n), 0) FROM (SELECT count(*) AS n FROM event_log
               WHERE ${CHECKS} AND created_at > now() - interval '90 days'
               GROUP BY date_trunc('hour', created_at)) h)::int AS best_hour`);
  return { days: n, pace, series: rows.map((x) => ({ ...x, d: iso(x.d), revenue_paise: Number(x.revenue_paise) })) };
}

/** One day, hour by hour — the drill-down under a day on the overview. */
async function overviewDay({ day }) {
  if (!isDay(day)) return { hours: [] };
  const { rows } = await db.query(
    `WITH h AS (SELECT generate_series(0, 23) AS h),
       u AS (SELECT extract(hour FROM f.at ${IST})::int AS h, count(*) AS n FROM (${FIRST}) f
              WHERE ${dayOf('f.at')} = $1::date AND ${NOT_STOPPED('f.m')} GROUP BY 1),
       c AS (SELECT extract(hour FROM created_at ${IST})::int AS h, count(*) AS n FROM event_log
              WHERE ${CHECKS} AND ${dayOf('created_at')} = $1::date GROUP BY 1),
       r AS (SELECT extract(hour FROM r.created_at ${IST})::int AS h, count(*) AS n FROM vehicle_reports r JOIN payments p ON p.id = r.payment_id
              WHERE ${PAID} AND ${dayOf('r.created_at')} = $1::date GROUP BY 1)
     SELECT h.h, coalesce(u.n, 0)::int AS customers, coalesce(c.n, 0)::int AS checks, coalesce(r.n, 0)::int AS reports
       FROM h LEFT JOIN u USING (h) LEFT JOIN c USING (h) LEFT JOIN r USING (h) ORDER BY h.h`, [day]);
  return { day, hours: rows };
}

/* ──────────────────────────────── funnel ──────────────────────────────── */

/* From "Agreed": someone who only said Hi is not counted anywhere in this admin. */
const STEPS = [
  ['agreed', 'Agreed to terms'], ['number', 'Sent a number'], ['basic_shown', 'Saw the free check'],
  ['buy_tapped', 'Tapped ₹19'], ['link_sent', 'Got the payment link'], ['paid', 'Paid'],
];

/* Who reached each step in the period, by mobile. "Paid" is a paid WhatsApp payment. */
const REACHED = `
  SELECT detail->>'step' AS step, detail->>'mobile' AS mobile, max(created_at) AS at
    FROM event_log WHERE kind = 'funnel' AND detail->>'step' = ANY($2::text[]) AND ${since('created_at')}
     AND ${AGREED("detail->>'mobile'")}
   GROUP BY 1, 2
  UNION ALL
  SELECT 'paid', u.mobile, max(p.paid_at) FROM payments p JOIN users u ON u.id = p.user_id
   WHERE ${PAID} AND ${since('p.paid_at')} AND ${AGREED('u.mobile')} GROUP BY 2`;

async function funnel({ days }) {
  const n = span(days);
  const { rows } = await db.query(
    `SELECT step, count(DISTINCT mobile)::int AS people FROM (${REACHED}) x GROUP BY 1`, [n, STEPS.map(([k]) => k)]);
  const by = Object.fromEntries(rows.map((r) => [r.step, r.people]));
  return { days: n, steps: STEPS.map(([key, label]) => ({ key, label, people: by[key] || 0 })) };
}

/** Who reached `step` in the period and went no further. */
async function funnelStep({ days, step }) {
  const n = span(days);
  const i = STEPS.findIndex(([k]) => k === step);
  if (i < 0) return { people: [] };
  const later = STEPS.slice(i + 1).map(([k]) => k);
  const { rows } = await db.query(
    `WITH x AS (${REACHED})
     SELECT x.mobile, x.at, coalesce(u.display_name, u.wa_profile_name) AS name
       FROM x LEFT JOIN users u ON u.mobile = x.mobile
      WHERE x.step = $3 AND NOT EXISTS (SELECT 1 FROM x y WHERE y.mobile = x.mobile AND y.step = ANY($4::text[]))
      ORDER BY x.at DESC LIMIT 100`, [n, STEPS.map(([k]) => k), step, later]);
  return { step, people: rows.map((r) => ({ mobile: r.mobile, masked: mask(r.mobile), name: r.name, at: r.at })) };
}

/* ──────────────────────────────── money ───────────────────────────────── */

async function money({ days }) {
  const n = span(days);
  const R = await ledger.rates();
  const { rows } = await db.query(
    `WITH ${DAYS},
       p AS (SELECT ${dayOf('paid_at')} AS d, sum(amount_paise) AS gross, count(*) AS n FROM payments p
              WHERE ${PAID} AND ${since('paid_at')} GROUP BY 1),
       a AS (SELECT ${dayOf('created_at')} AS d, sum(cost_paise) AS c FROM api_calls WHERE ${since('created_at')} GROUP BY 1),
       w AS (SELECT ${dayOf('m.created_at')} AS d, ${ledger.waCostSql('m', R)} AS c FROM whatsapp_messages m
              WHERE m.direction = 'out' AND m.message_type = 'template' AND ${since('m.created_at')} GROUP BY 1),
       s AS (SELECT day AS d, sum(amount_paise) AS c FROM ad_spend WHERE product = 'gaadipe' AND day >= ${FROM} GROUP BY 1)
     SELECT days.d, coalesce(p.gross, 0)::bigint AS gross, coalesce(p.n, 0)::int AS payments,
            coalesce(a.c, 0)::bigint AS api, coalesce(w.c, 0)::bigint AS whatsapp, coalesce(s.c, 0)::bigint AS ads
       FROM days LEFT JOIN p USING (d) LEFT JOIN a USING (d) LEFT JOIN w USING (d) LEFT JOIN s USING (d)
      ORDER BY days.d`, [n]);
  const g = Number(R.gst_percent || 18) / 100;
  const fee = (Number(R.fee_percent || 2) / 100) * (1 + Number(R.fee_gst_percent || 18) / 100);
  return {
    days: n,
    note: 'WhatsApp payments only. GST from the rate in force; the gateway fee estimated at the fee % in Settings; WhatsApp at the per-category rates.',
    series: rows.map((x) => {
      const gross = Number(x.gross);
      const gst = Math.round(gross - gross / (1 + g));
      const gateway = Math.round(gross * fee);
      const api = Number(x.api); const whatsapp = Number(x.whatsapp); const ads = Number(x.ads);
      return { d: iso(x.d), payments: x.payments, gross, gst, gateway, api, whatsapp, ads,
               left: gross - gst - gateway - api - whatsapp - ads };
    }),
  };
}

async function moneyDay({ day }) {
  if (!isDay(day)) return { payments: [] };
  const { rows } = await db.query(
    `SELECT p.id, p.amount_paise, p.paid_at, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
            (SELECT reg_no FROM vehicle_reports r WHERE r.payment_id = p.id LIMIT 1) AS reg_no
       FROM payments p JOIN users u ON u.id = p.user_id
      WHERE ${PAID} AND ${dayOf('p.paid_at')} = $1::date ORDER BY p.paid_at`, [day]);
  return { day, payments: rows.map((r) => ({ ...r, id: String(r.id), masked: mask(r.mobile) })) };
}

/* ─────────────────────────────── customers ────────────────────────────── */

/* Where a WhatsApp customer came from: a WhatsApp ad, or straight to the number. */
const SOURCE = `CASE WHEN ws.attribution->>'channel' = 'whatsapp_ad' THEN 'WhatsApp ads' ELSE 'WhatsApp direct' END`;
const NEW_PEOPLE = `(${FIRST}) f JOIN users u ON right(u.mobile, 10) = f.m LEFT JOIN whatsapp_sessions ws ON ws.mobile = u.mobile`;

async function customers({ days }) {
  const n = span(days);
  const [daily, sources, reasons] = await Promise.all([
    db.query(
      `WITH ${DAYS},
         nu AS (SELECT ${dayOf('f.at')} AS d, count(*) AS n FROM (${FIRST}) f WHERE ${since('f.at')} AND ${NOT_STOPPED('f.m')} GROUP BY 1),
         act AS (SELECT ${dayOf('e.occurred_at')} AS d, count(DISTINCT e.user_id) AS n FROM events e JOIN users u ON u.id = e.user_id
                  WHERE ${since('e.occurred_at')} AND e.channel <> 'web' AND ${dayOf('u.created_at')} < ${dayOf('e.occurred_at')}
                    AND ${AGREED('u.mobile')} GROUP BY 1),
         st AS (SELECT ${dayOf('created_at')} AS d, count(*) FILTER (WHERE detail->>'step' = 'opt_out') AS stops,
                       count(*) FILTER (WHERE detail->>'step' = 'opt_in') AS back
                  FROM event_log WHERE kind = 'funnel' AND detail->>'step' IN ('opt_out', 'opt_in') AND ${since('created_at')} GROUP BY 1)
       SELECT days.d, coalesce(nu.n, 0)::int AS new, coalesce(act.n, 0)::int AS returning,
              coalesce(st.stops, 0)::int AS stops, coalesce(st.back, 0)::int AS back
         FROM days LEFT JOIN nu USING (d) LEFT JOIN act USING (d) LEFT JOIN st USING (d) ORDER BY days.d`, [n]),
    db.query(
      `SELECT ${SOURCE} AS source, count(*)::int AS n FROM ${NEW_PEOPLE}
        WHERE ${since('f.at')} AND ${NOT_STOPPED('f.m')} GROUP BY 1 ORDER BY 2 DESC`, [n]),
    db.query(
      `SELECT detail->>'reason' AS reason, count(*)::int AS n FROM event_log
        WHERE kind = 'funnel' AND detail->>'step' = 'opt_out_reason' AND ${since('created_at')}
        GROUP BY 1 ORDER BY 2 DESC`, [n]),
  ]);
  return { days: n, series: daily.rows.map((x) => ({ ...x, d: iso(x.d) })), sources: sources.rows, reasons: reasons.rows };
}

/** The people behind a source or a STOP reason (STOP people are hidden by the admin's consent filter). */
async function customersOf({ days, source, reason, day }) {
  const n = span(days);
  if (isDay(day)) {
    const { rows } = await db.query(
      `SELECT e.detail->>'step' AS step, e.detail->>'mobile' AS mobile, e.created_at AS at,
              (e.detail->>'undo') = 'true' AS undo,
              coalesce(u.display_name, u.wa_profile_name) AS name,
              ws.wa_opt_out_at IS NOT NULL AS stopped_now,
              (SELECT r.detail->>'reason' FROM event_log r WHERE r.kind = 'funnel' AND r.detail->>'step' = 'opt_out_reason'
                 AND r.detail->>'mobile' = e.detail->>'mobile' AND r.created_at >= e.created_at - interval '1 minute'
               ORDER BY r.id LIMIT 1) AS reason,
              (SELECT r.detail->>'said' FROM event_log r WHERE r.kind = 'funnel' AND r.detail->>'step' = 'opt_out_reason'
                 AND r.detail->>'mobile' = e.detail->>'mobile' AND r.created_at >= e.created_at - interval '1 minute'
               ORDER BY r.id LIMIT 1) AS said,
              (SELECT count(*)::int FROM payments p WHERE p.user_id = u.id AND ${PAID}) AS paid
         FROM event_log e
         LEFT JOIN users u ON u.mobile = e.detail->>'mobile'
         LEFT JOIN whatsapp_sessions ws ON ws.mobile = e.detail->>'mobile'
        WHERE e.kind = 'funnel' AND e.detail->>'step' IN ('opt_out', 'opt_in') AND ${dayOf('e.created_at')} = $1::date
        ORDER BY e.created_at`, [day]);
    const person = (r) => ({ ...r, masked: mask(r.mobile) });
    return {
      day,
      stopped: rows.filter((r) => r.step === 'opt_out').map(person),
      came_back: rows.filter((r) => r.step === 'opt_in').map(person),
    };
  }
  if (reason) {
    const { rows } = await db.query(
      `SELECT e.detail->>'mobile' AS mobile, e.detail->>'said' AS said, e.created_at AS at,
              coalesce(u.display_name, u.wa_profile_name) AS name
         FROM event_log e LEFT JOIN users u ON u.mobile = e.detail->>'mobile'
        WHERE e.kind = 'funnel' AND e.detail->>'step' = 'opt_out_reason' AND e.detail->>'reason' = $2 AND ${since('e.created_at')}
        ORDER BY e.id DESC LIMIT 100`, [n, String(reason)]);
    return { people: rows.map((r) => ({ ...r, masked: mask(r.mobile) })) };
  }
  const { rows } = await db.query(
    `SELECT u.mobile, f.at, coalesce(u.display_name, u.wa_profile_name) AS name
       FROM ${NEW_PEOPLE}
      WHERE ${since('f.at')} AND ${NOT_STOPPED('f.m')} AND ${SOURCE} = $2 ORDER BY f.at DESC LIMIT 100`, [n, String(source || '')]);
  return { people: rows.map((r) => ({ ...r, masked: mask(r.mobile) })) };
}

/* ─────────────────────────────── vehicles ─────────────────────────────── */

const REG = `upper(regexp_replace(detail->>'reg_no', '[^A-Za-z0-9]', '', 'g'))`;

async function vehicles({ days }) {
  const n = span(days);
  const [states, kinds, expiring] = await Promise.all([
    db.query(
      `SELECT substring(${REG} from 1 for 2) AS code, count(*)::int AS checks, count(DISTINCT ${REG})::int AS vehicles
         FROM event_log WHERE ${CHECKS} AND ${since('created_at')} GROUP BY 1 ORDER BY 2 DESC`, [n]),
    db.query(
      `WITH v AS (SELECT DISTINCT ${REG} AS reg FROM event_log WHERE ${CHECKS} AND ${since('created_at')})
       SELECT coalesce(nullif(s.data->>'vehicle_class', ''), 'Not known') AS class,
              coalesce(nullif(s.data->>'fuel', ''), 'Not known') AS fuel,
              coalesce(nullif(initcap(split_part(s.data->>'maker', ' ', 1)), ''), 'Not known') AS maker, count(*)::int AS n
         FROM v JOIN vehicles ve ON ve.reg_no = v.reg JOIN vehicle_snapshots s ON s.vehicle_id = ve.id AND s.dataset = 'rc'
        GROUP BY 1, 2, 3`, [n]),
    db.query(
      `WITH m AS (SELECT generate_series(date_trunc('month', now() ${IST}), date_trunc('month', now() ${IST}) + interval '11 months', interval '1 month')::date AS m),
            docs AS (
              SELECT date_trunc('month', (s.data->>k.f)::date)::date AS m, k.label
                FROM vehicle_snapshots s
                CROSS JOIN (VALUES ('insurance_upto', 'Insurance'), ('pucc_upto', 'PUC'), ('tax_upto', 'Road tax'), ('fitness_upto', 'Fitness')) AS k(f, label)
               WHERE s.dataset = 'rc' AND s.data->>k.f ~ '^\\d{4}-\\d{2}-\\d{2}$')
       SELECT m.m, d.label, count(d.label)::int AS n FROM m LEFT JOIN docs d ON d.m = m.m GROUP BY 1, 2 ORDER BY 1`),
  ]);
  const months = {};
  for (const r of expiring.rows) {
    const key = iso(r.m).slice(0, 7);
    months[key] ??= { month: key, Insurance: 0, PUC: 0, 'Road tax': 0, Fitness: 0 };
    if (r.label) months[key][r.label] = r.n;
  }
  const sum = (key) => Object.entries(kinds.rows.reduce((a, r) => ({ ...a, [r[key]]: (a[r[key]] || 0) + r.n }), {}))
    .map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  return {
    days: n,
    states: states.rows.map((s) => ({ ...s, name: geo.STATES[s.code] || s.code })),
    classes: sum('class'), fuels: sum('fuel'), makers: sum('maker').slice(0, 15),
    expiring: Object.values(months),
  };
}

/** A state's RTOs, or an RTO's vehicles. */
async function vehiclesOf({ days, state, rto }) {
  const n = span(days);
  if (rto) {
    const { rows } = await db.query(
      `SELECT ${REG} AS reg_no, count(*)::int AS checks, max(created_at) AS last
         FROM event_log WHERE ${CHECKS} AND ${since('created_at')} AND ${REG} LIKE $2 || '%'
        GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 200`, [n, String(rto).toUpperCase()]);
    return { rto, vehicles: rows };
  }
  const st = String(state || '').toUpperCase().slice(0, 2);
  const { rows } = await db.query(
    `SELECT ${REG} AS reg FROM event_log WHERE ${CHECKS} AND ${since('created_at')} AND ${REG} LIKE $2 || '%'`, [n, st]);
  const by = {};
  for (const r of rows) {
    const code = geo.rtoCode(r.reg);
    if (!code) continue;
    by[code] ??= { code, checks: 0, regs: new Set() };
    by[code].checks += 1; by[code].regs.add(r.reg);
  }
  const names = await geo.rtoNames(Object.keys(by));
  return {
    state: st,
    rtos: Object.values(by).map((x) => ({ code: x.code, name: names[x.code] || null, checks: x.checks, vehicles: x.regs.size }))
      .sort((a, b) => b.checks - a.checks),
  };
}

/* ─────────────────────────────── whatsapp ─────────────────────────────── */

/* Messages in and out and what Meta bills — every message (that is the bill); "people" counts only those who agreed. */
async function whatsapp({ days }) {
  const n = span(days);
  const R = await ledger.rates();
  const cat = `upper(coalesce((SELECT t.category FROM wa_templates t WHERE t.template_name = m.template_name LIMIT 1), ''))`;
  const ok = `coalesce(m.error_message, '') = ''`;
  const win = `EXISTS (SELECT 1 FROM whatsapp_messages wi WHERE wi.mobile = m.mobile AND wi.direction = 'in'
                      AND wi.created_at <= m.created_at AND wi.created_at > m.created_at - interval '24 hours')`;
  const { rows } = await db.query(
    `WITH ${DAYS},
       x AS (SELECT ${dayOf('m.created_at')} AS d,
                    count(*) FILTER (WHERE m.direction = 'in') AS inbound,
                    count(*) FILTER (WHERE m.direction = 'out' AND m.message_type <> 'template') AS replies,
                    count(*) FILTER (WHERE m.direction = 'out' AND m.message_type = 'template') AS templates,
                    count(DISTINCT m.mobile) FILTER (WHERE m.direction = 'in' AND ${AGREED('m.mobile')}) AS people,
                    coalesce(sum(CASE WHEN m.direction = 'out' AND m.message_type = 'template' AND ${ok} AND ${cat} = 'MARKETING' THEN ${Number(R.wa_marketing_paise) || 0} END), 0) AS marketing,
                    coalesce(sum(CASE WHEN m.direction = 'out' AND m.message_type = 'template' AND ${ok} AND ${cat} = 'UTILITY' AND NOT ${win} THEN ${Number(R.wa_utility_paise) || 0} END), 0) AS utility,
                    coalesce(sum(CASE WHEN m.direction = 'out' AND m.message_type = 'template' AND ${ok} AND ${cat} NOT IN ('MARKETING', 'UTILITY') THEN ${Number(R.wa_rate_paise) || 0} END), 0) AS other
               FROM whatsapp_messages m WHERE ${since('m.created_at')} GROUP BY 1)
     SELECT days.d, coalesce(x.inbound, 0)::int AS inbound, coalesce(x.replies, 0)::int AS replies,
            coalesce(x.templates, 0)::int AS templates, coalesce(x.people, 0)::int AS people,
            coalesce(x.marketing, 0)::int AS marketing, coalesce(x.utility, 0)::int AS utility, coalesce(x.other, 0)::int AS other
       FROM days LEFT JOIN x USING (d) ORDER BY days.d`, [n]);
  return { days: n, limit: await settings.num('whatsapp_messaging_limit', 250), series: rows.map((x) => ({ ...x, d: iso(x.d) })) };
}

async function whatsappDay({ day }) {
  if (!isDay(day)) return { kinds: [] };
  const { rows } = await db.query(
    `SELECT direction, CASE WHEN message_type = 'template' THEN 'Template · ' || coalesce(template_name, '?') ELSE message_type END AS kind,
            count(*)::int AS n
       FROM whatsapp_messages WHERE ${dayOf('created_at')} = $1::date GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 40`, [day]);
  return { day, kinds: rows };
}

/* ───────────────────────────── today, live ───────────────────────────── */

/*
 * TODAY, LIVE: what happened today on WhatsApp, in time buckets from midnight
 * IST (or the last hour / three hours) — people (who agreed) saying hi, free
 * checks found / no such vehicle / failed, ₹19 taps, paid WhatsApp reports and
 * the money, and STOPs. The panel asks again every minute.
 */
const WINDOWS = {
  hour: { minutes: 60, bucket: 1, label: 'Last 60 minutes' },
  three: { minutes: 180, bucket: 5, label: 'Last 3 hours' },
  today: { minutes: null, bucket: 15, label: 'Today' },
};
const LIVE_STEPS = ['hi', 'basic_shown', 'lookup_failed', 'buy_tapped', 'opt_out'];
/* STOP is counted (it is what we must watch); every other step only for people who agreed. */
const LIVE_WHO = `(detail->>'step' = 'opt_out' OR ${AGREED("detail->>'mobile'")})`;

async function today({ window: w = 'today' } = {}) {
  const win = WINDOWS[w] || WINDOWS.today;
  const step = win.bucket * 60;
  const mid = await db.one(`SELECT extract(epoch FROM date_trunc('day', now() ${IST}) AT TIME ZONE 'Asia/Kolkata')::bigint AS t`);
  const startEpoch = win.minutes ? Math.floor((Date.now() / 1000 - win.minutes * 60) / step) * step + step : Number(mid.t);
  const start = new Date(startEpoch * 1000).toISOString();
  const B = (col) => `(floor(extract(epoch FROM ${col}) / $2) * $2)::bigint`;
  const [ev, pay, totals, feed] = await Promise.all([
    db.query(
      `SELECT ${B('created_at')} AS t, detail->>'step' AS step,
              CASE WHEN detail->>'reason' = 'not_found' THEN 'not_found' ELSE 'other' END AS reason,
              count(*)::int AS n, count(DISTINCT detail->>'mobile')::int AS people
         FROM event_log WHERE kind = 'funnel' AND created_at >= $1::timestamptz AND detail->>'step' = ANY($3::text[])
          AND ${LIVE_WHO}
        GROUP BY 1, 2, 3`, [start, step, LIVE_STEPS]),
    db.query(
      `SELECT ${B('paid_at')} AS t, count(*)::int AS n, sum(amount_paise)::bigint AS paise
         FROM payments p WHERE ${PAID} AND paid_at >= $1::timestamptz GROUP BY 1`, [start, step]),
    db.one(
      `WITH f AS (SELECT * FROM event_log WHERE kind = 'funnel' AND created_at >= to_timestamp($1) AND ${LIVE_WHO})
       SELECT (SELECT count(DISTINCT detail->>'mobile') FROM f WHERE detail->>'step' = 'hi')::int AS hi,
              (SELECT count(*) FROM f WHERE detail->>'step' = 'basic_shown')::int AS checked,
              (SELECT count(*) FROM f WHERE detail->>'step' = 'lookup_failed' AND detail->>'reason' = 'not_found')::int AS not_found,
              (SELECT count(*) FROM f WHERE detail->>'step' = 'lookup_failed' AND coalesce(detail->>'reason', '') <> 'not_found')::int AS failed,
              (SELECT count(*) FROM f WHERE detail->>'step' = 'buy_tapped')::int AS tapped,
              (SELECT count(*) FROM f WHERE detail->>'step' = 'opt_out')::int AS stops,
              (SELECT count(*) FROM payments p WHERE ${PAID} AND paid_at >= to_timestamp($1))::int AS paid,
              (SELECT coalesce(sum(amount_paise), 0) FROM payments p WHERE ${PAID} AND paid_at >= to_timestamp($1))::bigint AS revenue_paise`,
      [Number(mid.t)]),
    db.query(
      `(SELECT e.created_at AS at, e.detail->>'step' AS step, e.detail->>'reason' AS reason, e.detail->>'reg_no' AS reg_no,
               e.detail->>'mobile' AS mobile, NULL::bigint AS paise
          FROM event_log e WHERE e.kind = 'funnel' AND e.created_at >= $1::timestamptz AND e.detail->>'step' = ANY($2::text[])
           AND e.detail->>'step' <> 'opt_out' AND ${AGREED("e.detail->>'mobile'")}
         ORDER BY e.created_at DESC LIMIT 30)
       UNION ALL
       (SELECT p.paid_at, 'paid', NULL, NULL, u.mobile, p.amount_paise
          FROM payments p LEFT JOIN users u ON u.id = p.user_id
         WHERE ${PAID} AND p.paid_at >= $1::timestamptz ORDER BY p.paid_at DESC LIMIT 10)
       ORDER BY at DESC LIMIT 30`, [start, LIVE_STEPS]),
  ]);

  // Every bucket from the start to now, zeros included, so the line moves on.
  const now = Math.floor(Date.now() / 1000 / step) * step;
  const by = new Map();
  for (let t = Math.floor(startEpoch / step) * step; t <= now; t += step) {
    by.set(t, { t: new Date(t * 1000).toISOString(), hi: 0, checked: 0, not_found: 0, failed: 0, tapped: 0, paid: 0, revenue_paise: 0, stops: 0 });
  }
  for (const r of ev.rows) {
    const b = by.get(Number(r.t)); if (!b) continue;
    if (r.step === 'hi') b.hi += r.people;
    else if (r.step === 'basic_shown') b.checked += r.n;
    else if (r.step === 'lookup_failed') b[r.reason === 'not_found' ? 'not_found' : 'failed'] += r.n;
    else if (r.step === 'buy_tapped') b.tapped += r.n;
    else if (r.step === 'opt_out') b.stops += r.n;
  }
  for (const r of pay.rows) {
    const b = by.get(Number(r.t)); if (!b) continue;
    b.paid += r.n; b.revenue_paise += Number(r.paise || 0);
  }
  const names = feed.rows.length ? await db.query(
    `SELECT mobile, coalesce(display_name, wa_profile_name) AS name FROM users WHERE mobile = ANY($1::text[])`,
    [[...new Set(feed.rows.map((r) => r.mobile).filter(Boolean))]]) : { rows: [] };
  const nameOf = new Map(names.rows.map((r) => [r.mobile, r.name]));
  return {
    window: w in WINDOWS ? w : 'today', label: win.label, bucket_minutes: win.bucket,
    series: [...by.values()],
    totals: { ...totals, revenue_paise: Number(totals.revenue_paise) },
    feed: feed.rows.map((r) => ({
      at: r.at, step: r.step, reason: r.reason, reg_no: r.reg_no, paise: r.paise == null ? null : Number(r.paise),
      mobile: r.mobile, masked: mask(r.mobile), name: nameOf.get(r.mobile) || null,
    })),
    checked_at: new Date().toISOString(),
  };
}

/* ─────────────────────────────── helpers ──────────────────────────────── */

function iso(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/* Services & APIs are the same for both admins (provider calls, not people). */
const web = require('./graphs');
const PAGES = { overview, funnel, money, customers, vehicles, whatsapp, services: web.PAGES.services, today };
const DRILLS = {
  overview: overviewDay, funnel: funnelStep, money: moneyDay, customers: customersOf,
  vehicles: vehiclesOf, whatsapp: whatsappDay, services: web.DRILLS.services,
};

module.exports = { PAGES, DRILLS };
