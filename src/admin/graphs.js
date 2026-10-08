/**
 * src/admin/graphs.js — the numbers behind the admin's Graphs section (user,
 * 2026-10-03: "a separate main option for graphs only … nested graphs").
 *
 * THE WEBSITE ONLY (2026-10-07: WhatsApp is retired, and every comparison is
 * the website's). Each page is a set of daily series over the last 7, 30 or 90
 * days (IST days, every day present — a quiet day is a zero, not a gap) and a
 * drill-down for the mark that was clicked:
 *
 *   overview   website customers, checks (distinct / repeat), reports, revenue → a day by hour
 *   funnel     visit → checked → saw it → tapped Full report → payment → paid → report → who stopped
 *   money      website revenue, GST, gateway fee, API, SMS, ads, what is left   → a day's payments
 *   customers  new vs returning, sign-ins, where they came from (ads, search…) → the people
 *   vehicles   checks by state, type / fuel / make, documents expiring        → state → RTO → vehicles
 *   services   provider calls answered / failed, speed, RC backup spend       → a provider's errors
 *   today      today, minute by minute
 *
 * Read-only. Everything here is already elsewhere in the panel as tables; this
 * only draws it.
 */

const db = require('../db');
const settings = require('../util/settings');
const ledger = require('../finance/ledger');
const geo = require('./geo');

const IST = `AT TIME ZONE 'Asia/Kolkata'`;
const dayOf = (col) => `(${col} ${IST})::date`;
const span = (days) => [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

/* The period's days, oldest first, as $1 = number of days. */
const DAYS = `days AS (SELECT generate_series((now() ${IST})::date - ($1::int - 1), (now() ${IST})::date, interval '1 day')::date AS d)`;
const FROM = `((now() ${IST})::date - ($1::int - 1))`;
const since = (col) => `${col} >= (${FROM}::timestamp ${IST})`;

/* A website vehicle check: a free check in the chat, or a signed-in check on the website. */
const CHECKS = `(kind = 'chat_anon_check' OR (kind IN ('vehicle_check', 'vehicle_check_repeat') AND detail->>'channel' = 'web'))`;
/* A paid website payment. */
const PAID = `p.status = 'paid' AND p.amount_paise > 0 AND coalesce(p.raw->>'channel', p.raw->'paid_from'->>'channel', 'whatsapp') = 'web'`;
const mask = (m) => (m ? `••••••${String(m).slice(-4)}` : null);

/* ─────────────────────────────── overview ─────────────────────────────── */

async function overview({ days }) {
  const n = span(days);
  const { rows } = await db.query(
    `WITH ${DAYS},
       u AS (SELECT ${dayOf('created_at')} AS d, count(*) AS n FROM users WHERE signup_channel = 'web' AND ${since('created_at')} GROUP BY 1),
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
  // The check speedometer (2026-10-03): checks in the last hour against the
  // busiest single hour of the last 90 days.
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
       u AS (SELECT extract(hour FROM created_at ${IST})::int AS h, count(*) AS n FROM users
              WHERE signup_channel = 'web' AND ${dayOf('created_at')} = $1::date GROUP BY 1),
       c AS (SELECT extract(hour FROM created_at ${IST})::int AS h, count(*) AS n FROM event_log
              WHERE ${CHECKS} AND ${dayOf('created_at')} = $1::date GROUP BY 1),
       r AS (SELECT extract(hour FROM r.created_at ${IST})::int AS h, count(*) AS n FROM vehicle_reports r JOIN payments p ON p.id = r.payment_id
              WHERE ${PAID} AND ${dayOf('r.created_at')} = $1::date GROUP BY 1)
     SELECT h.h, coalesce(u.n, 0)::int AS customers, coalesce(c.n, 0)::int AS checks, coalesce(r.n, 0)::int AS reports
       FROM h LEFT JOIN u USING (h) LEFT JOIN c USING (h) LEFT JOIN r USING (h) ORDER BY h.h`, [day]);
  return { day, hours: rows };
}

/* ──────────────────────────────── funnel ──────────────────────────────── */

/* The website's journey, one visit per step (admin/analytics.js — the same stages everywhere). */
const STEPS = [
  ['visited', 'Visited the website'], ['searched', 'Checked a vehicle'], ['saw', 'Saw the vehicle'],
  ['cta', 'Tapped Full report'], ['pay_started', 'Payment started'], ['paid', 'Paid'], ['report', 'Report generated'],
];
async function visitsSince(n) {
  const a = await db.one(`SELECT (${FROM}::timestamp ${IST}) AS a`, [n]);
  return require('./analytics').perVisit({ from: a.a, to: new Date() });
}

async function funnel({ days }) {
  const n = span(days);
  const visits = await visitsSince(n);
  return { days: n, steps: STEPS.map(([key, label]) => ({ key, label, people: visits.filter((v) => v.at[key]).length })) };
}

/** The visits that reached `step` in the period and went no further. */
async function funnelStep({ days, step }) {
  const n = span(days);
  const i = STEPS.findIndex(([k]) => k === step);
  if (i < 0) return { people: [] };
  const next = STEPS[i + 1]?.[0];
  const rows = (await visitsSince(n)).filter((v) => v.at[step] && (!next || !v.at[next])).slice(0, 100);
  return { step, people: rows.map((v) => ({ mobile: v.mobile, masked: mask(v.mobile), name: v.name || (v.user_id ? null : 'Not signed in'),
    at: v.at[step], session_id: v.session_id })) };
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
       o AS (SELECT ${dayOf('created_at')} AS d, count(*) AS n FROM site_otps WHERE ${since('created_at')} GROUP BY 1),
       s AS (SELECT day AS d, sum(amount_paise) AS c FROM ad_spend WHERE product = 'gaadipe' AND day >= ${FROM} GROUP BY 1)
     SELECT days.d, coalesce(p.gross, 0)::bigint AS gross, coalesce(p.n, 0)::int AS payments,
            coalesce(a.c, 0)::bigint AS api, coalesce(o.n, 0)::int AS sms_n, coalesce(s.c, 0)::bigint AS ads
       FROM days LEFT JOIN p USING (d) LEFT JOIN a USING (d) LEFT JOIN o USING (d) LEFT JOIN s USING (d)
      ORDER BY days.d`, [n]);
  const g = Number(R.gst_percent || 18) / 100;
  const fee = (Number(R.fee_percent || 2) / 100) * (1 + Number(R.fee_gst_percent || 18) / 100);
  const smsRate = Number(R.sms_rate_paise || 0);
  return {
    days: n,
    note: 'Website payments. GST from the rate in force; the gateway fee estimated at the fee % in Settings; SMS sign-in codes at the SMS rate.',
    series: rows.map((x) => {
      const gross = Number(x.gross);
      const gst = Math.round(gross - gross / (1 + g));
      const gateway = Math.round(gross * fee);
      const api = Number(x.api); const sms = Number(x.sms_n) * smsRate; const ads = Number(x.ads);
      return { d: iso(x.d), payments: x.payments, gross, gst, gateway, api, sms, ads,
               left: gross - gst - gateway - api - sms - ads };
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

/* Where a website customer first came from: their earliest website visit's source. */
const SOURCE = `coalesce((SELECT CASE coalesce(nullif(v.first_touch->>'source', ''), 'direct')
                                   WHEN 'google_ads' THEN 'Google Ads' WHEN 'meta_ads' THEN 'Meta ads' WHEN 'google' THEN 'Google search'
                                   WHEN 'organic' THEN 'Other search' WHEN 'social' THEN 'Social media' WHEN 'referral' THEN 'Another website'
                                   ELSE 'Direct / typed the address' END
                              FROM visitors v WHERE v.user_id = u.id ORDER BY v.first_seen_at LIMIT 1), 'Not known')`;

async function customers({ days }) {
  const n = span(days);
  const [daily, sources] = await Promise.all([
    db.query(
      `WITH ${DAYS},
         nu AS (SELECT ${dayOf('created_at')} AS d, count(*) AS n FROM users WHERE signup_channel = 'web' AND ${since('created_at')} GROUP BY 1),
         act AS (SELECT ${dayOf('e.occurred_at')} AS d, count(DISTINCT e.user_id) AS n FROM events e JOIN users u ON u.id = e.user_id
                  WHERE e.channel = 'web' AND ${since('e.occurred_at')} AND ${dayOf('u.created_at')} < ${dayOf('e.occurred_at')} GROUP BY 1),
         si AS (SELECT ${dayOf('created_at')} AS d, count(*) AS n FROM event_log WHERE kind = 'site_sign_in' AND ${since('created_at')} GROUP BY 1)
       SELECT days.d, coalesce(nu.n, 0)::int AS new, coalesce(act.n, 0)::int AS returning, coalesce(si.n, 0)::int AS sign_ins
         FROM days LEFT JOIN nu USING (d) LEFT JOIN act USING (d) LEFT JOIN si USING (d) ORDER BY days.d`, [n]),
    db.query(
      `SELECT ${SOURCE} AS source, count(*)::int AS n
         FROM users u WHERE u.signup_channel = 'web' AND ${since('u.created_at')} GROUP BY 1 ORDER BY 2 DESC`, [n]),
  ]);
  return { days: n, series: daily.rows.map((x) => ({ ...x, d: iso(x.d) })), sources: sources.rows, reasons: [] };
}

/** The people behind a source. */
async function customersOf({ days, source }) {
  const n = span(days);
  const { rows } = await db.query(
    `SELECT u.mobile, u.created_at AS at, coalesce(u.display_name, u.wa_profile_name) AS name
       FROM users u WHERE u.signup_channel = 'web' AND ${since('u.created_at')} AND ${SOURCE} = $2
      ORDER BY u.created_at DESC LIMIT 100`, [n, String(source || '')]);
  return { people: rows.map((r) => ({ ...r, masked: mask(r.mobile) })) };
}
/* ─────────────────────────────── vehicles ─────────────────────────────── */

const REG = `upper(regexp_replace(detail->>'reg_no', '[^A-Za-z0-9]', '', 'g'))`;

/*
 * ALL VEHICLES, FROM DAY ONE (user, 2026-10-08: "take full from day one to
 * today — that's OK if users from WhatsApp, vehicles important"). Unlike the
 * other pages this one is not the website's period: every vehicle GaadiPe has
 * ever checked, on any channel, with its checks — signed-in checks (WhatsApp
 * and website, user_vehicles.check_count) plus the website's free checks
 * before sign-in (event_log chat_anon_check). The period picker does not apply.
 */
const ANON_REG = `upper(regexp_replace(detail->>'reg_no', '[^A-Za-z0-9]', '', 'g'))`;
const PER_VEHICLE = `
  chk AS (SELECT vehicle_id, sum(coalesce(check_count, 1))::int AS n, max(last_checked_at) AS last FROM user_vehicles GROUP BY 1),
  anon AS (SELECT ${ANON_REG} AS reg, count(*)::int AS n, max(created_at) AS last FROM event_log WHERE kind = 'chat_anon_check' GROUP BY 1),
  pv AS (SELECT v.id, v.reg_no, v.first_seen_at,
                greatest(1, coalesce(chk.n, 0) + coalesce(anon.n, 0)) AS checks,
                greatest(chk.last, anon.last, v.last_seen_at) AS last
           FROM vehicles v LEFT JOIN chk ON chk.vehicle_id = v.id LEFT JOIN anon ON anon.reg = v.reg_no)`;

async function vehicles() {
  const [states, kinds, expiring, growth] = await Promise.all([
    db.query(
      `WITH ${PER_VEHICLE}
       SELECT substring(reg_no from 1 for 2) AS code, sum(checks)::int AS checks, count(*)::int AS vehicles
         FROM pv GROUP BY 1 ORDER BY 2 DESC`),
    db.query(
      `SELECT coalesce(nullif(vehicle_class, ''), 'Not known') AS class,
              coalesce(nullif(fuel, ''), 'Not known') AS fuel,
              coalesce(nullif(initcap(split_part(maker, ' ', 1)), ''), 'Not known') AS maker, count(*)::int AS n
         FROM vehicles GROUP BY 1, 2, 3`),
    db.query(
      `WITH m AS (SELECT generate_series(date_trunc('month', now() ${IST}), date_trunc('month', now() ${IST}) + interval '11 months', interval '1 month')::date AS m),
            docs AS (
              SELECT date_trunc('month', k.d)::date AS m, k.label
                FROM vehicles v
                CROSS JOIN LATERAL (VALUES (v.insurance_upto, 'Insurance'), (v.pucc_upto, 'PUC'), (v.tax_upto, 'Road tax'), (v.fitness_upto, 'Fitness')) AS k(d, label)
               WHERE k.d IS NOT NULL)
       SELECT m.m, d.label, count(d.label)::int AS n FROM m LEFT JOIN docs d ON d.m = m.m GROUP BY 1, 2 ORDER BY 1`),
    db.query(
      `SELECT to_char(date_trunc('month', first_seen_at ${IST}), 'YYYY-MM') AS month, count(*)::int AS added
         FROM vehicles WHERE first_seen_at IS NOT NULL GROUP BY 1 ORDER BY 1`),
  ]);
  let total = 0;
  const added = growth.rows.map((r) => { total += r.added; return { month: r.month, added: r.added, total }; });
  const months = {};
  for (const r of expiring.rows) {
    const key = iso(r.m).slice(0, 7);
    months[key] ??= { month: key, Insurance: 0, PUC: 0, 'Road tax': 0, Fitness: 0 };
    if (r.label) months[key][r.label] = r.n;
  }
  const sum = (key) => Object.entries(kinds.rows.reduce((a, r) => ({ ...a, [r[key]]: (a[r[key]] || 0) + r.n }), {}))
    .map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  return {
    all_time: true,
    since: added[0]?.month || null,
    states: states.rows.map((s) => ({ ...s, name: geo.STATES[s.code] || s.code })),
    classes: sum('class'), fuels: sum('fuel'), makers: sum('maker').slice(0, 15),
    expiring: Object.values(months),
    added,
  };
}

/** A state's RTOs, or an RTO's vehicles — all time, every channel, like the page. */
async function vehiclesOf({ state, rto }) {
  if (rto) {
    const { rows } = await db.query(
      `WITH ${PER_VEHICLE}
       SELECT reg_no, checks, last FROM pv WHERE reg_no LIKE $1 || '%'
        ORDER BY checks DESC, last DESC NULLS LAST LIMIT 200`, [String(rto).toUpperCase().replace(/[^A-Z0-9]/g, '')]);
    return { rto, vehicles: rows };
  }
  const st = String(state || '').toUpperCase().slice(0, 2);
  const { rows } = await db.query(
    `WITH ${PER_VEHICLE} SELECT reg_no AS reg, checks FROM pv WHERE reg_no LIKE $1 || '%'`, [st]);
  const by = {};
  for (const r of rows) {
    const code = geo.rtoCode(r.reg);
    if (!code) continue;
    by[code] ??= { code, checks: 0, regs: new Set() };
    by[code].checks += r.checks; by[code].regs.add(r.reg);
  }
  const names = await geo.rtoNames(Object.keys(by));
  return {
    state: st,
    rtos: Object.values(by).map((x) => ({ code: x.code, name: names[x.code] || null, checks: x.checks, vehicles: x.regs.size }))
      .sort((a, b) => b.checks - a.checks),
  };
}

/* ─────────────────────────────── services ─────────────────────────────── */

const PROVIDER = `CASE WHEN provider_path = 'RCBACKUP' THEN 'RC backup'
                       WHEN provider_path LIKE 'VAHAN%' THEN 'VAHAN (RC)'
                       WHEN provider_path LIKE 'ECHALLAN%' THEN 'eChallan'
                       WHEN provider_path LIKE 'FASTAG%' THEN 'FASTag'
                       ELSE coalesce(provider_path, 'Other') END`;

async function services({ days }) {
  const n = span(days);
  const [daily, totals] = await Promise.all([
    db.query(
      `WITH ${DAYS},
         x AS (SELECT ${dayOf('created_at')} AS d, ${PROVIDER} AS provider,
                      count(*) FILTER (WHERE ok) AS ok, count(*) FILTER (WHERE NOT ok) AS failed,
                      round(avg(duration_ms) FILTER (WHERE ok))::int AS ms,
                      sum(cost_paise) FILTER (WHERE provider_path = 'RCBACKUP') AS backup_paise
                 FROM api_calls WHERE NOT cache_hit AND ${since('created_at')} GROUP BY 1, 2)
       SELECT days.d, x.provider, coalesce(x.ok, 0)::int AS ok, coalesce(x.failed, 0)::int AS failed, x.ms,
              coalesce(x.backup_paise, 0)::int AS backup_paise
         FROM days LEFT JOIN x USING (d) ORDER BY days.d`, [n]),
    db.query(
      `SELECT ${PROVIDER} AS provider, count(*) FILTER (WHERE ok)::int AS ok, count(*) FILTER (WHERE NOT ok)::int AS failed,
              round(avg(duration_ms) FILTER (WHERE ok))::int AS ms
         FROM api_calls WHERE NOT cache_hit AND ${since('created_at')} GROUP BY 1 ORDER BY 2 DESC`, [n]),
  ]);
  const byDay = {};
  for (const r of daily.rows) {
    const d = iso(r.d);
    byDay[d] ??= { d, backup_paise: 0 };
    if (r.provider) {
      byDay[d][`${r.provider}|ok`] = r.ok; byDay[d][`${r.provider}|failed`] = r.failed; byDay[d][`${r.provider}|ms`] = r.ms;
      byDay[d].backup_paise += r.backup_paise;
    }
  }
  // Today's RC backup calls against the daily limit — the "fuel" gauge.
  const backup = await require('../vehicle/rcBackup').today().catch(() => null);
  return {
    days: n, providers: totals.rows, series: Object.values(byDay), backup_today: backup,
    note: 'Calls recorded with each answered lookup. A lookup that failed on every source is not recorded here — the Services strip shows those live.',
  };
}

async function servicesOf({ days, provider }) {
  const n = span(days);
  const { rows } = await db.query(
    `SELECT coalesce(nullif(error_code, ''), outcome, 'unknown') AS code, count(*)::int AS n, max(created_at) AS last
       FROM api_calls WHERE NOT cache_hit AND NOT ok AND ${since('created_at')} AND ${PROVIDER} = $2
      GROUP BY 1 ORDER BY 2 DESC LIMIT 30`, [n, String(provider || '')]);
  return { provider, errors: rows };
}

/* ───────────────────────────── today, live ───────────────────────────── */

/*
 * TODAY, LIVE (user, 2026-10-06: "today's timeline about customer, vehicle
 * check, failed or success, full report and more in one graph, every minute").
 * What happened today, in time buckets from midnight IST (or the last hour /
 * three hours), each bucket counting:
 *
 *   hi          different people who said hi
 *   checked     free checks shown (a vehicle found)
 *   not_found   lookups where the vehicle does not exist
 *   failed      lookups that failed (the services were down)
 *   tapped      taps on the ₹19 full report
 *   paid        full reports paid, and the money
 *   stops       people who said STOP
 *
 * From the same funnel events and payments as the other graphs, so the numbers
 * agree with them. The panel asks again every minute.
 */
const WINDOWS = {
  hour: { minutes: 60, bucket: 1, label: 'Last 60 minutes' },
  three: { minutes: 180, bucket: 5, label: 'Last 3 hours' },
  today: { minutes: null, bucket: 15, label: 'Today' },
};
/*
 * TODAY, LIVE — THE WEBSITE (2026-10-07: WhatsApp is retired; the chart was the
 * WhatsApp bot's steps and went blank). Per bucket: vehicle checks on the
 * website (free chat checks and signed-in checks) found / no such vehicle /
 * failed, visits started, sign-ins, and full reports paid on the website.
 */
const WEB_CHECK_KINDS = `(kind = 'chat_anon_check' OR (kind IN ('vehicle_check', 'vehicle_check_repeat') AND detail->>'channel' = 'web'))`;
const CHECK_OUTCOME = `CASE WHEN coalesce(detail->>'found', 'true') <> 'false' THEN 'checked'
                            WHEN detail->>'error' = 'vehicle_not_found' THEN 'not_found' ELSE 'failed' END`;
const WEB_PAID = `${PAID} AND coalesce(p.raw->>'channel', p.raw->'paid_from'->>'channel', 'whatsapp') = 'web'`;

async function today({ window: w = 'today' } = {}) {
  const win = WINDOWS[w] || WINDOWS.today;
  const step = win.bucket * 60;
  // The start: IST midnight today, or now minus the window — on a bucket boundary.
  const mid = await db.one(`SELECT extract(epoch FROM date_trunc('day', now() ${IST}) AT TIME ZONE 'Asia/Kolkata')::bigint AS t`);
  const startEpoch = win.minutes ? Math.floor((Date.now() / 1000 - win.minutes * 60) / step) * step + step : Number(mid.t);
  const start = new Date(startEpoch * 1000).toISOString();
  const B = (col) => `(floor(extract(epoch FROM ${col}) / $2) * $2)::bigint`;
  const [checks, visits, signIns, pay, totals, feed] = await Promise.all([
    db.query(
      `SELECT ${B('created_at')} AS t, ${CHECK_OUTCOME} AS outcome, count(*)::int AS n
         FROM event_log WHERE created_at >= $1::timestamptz AND ${WEB_CHECK_KINDS} GROUP BY 1, 2`, [start, step]),
    db.query(
      `SELECT ${B('occurred_at')} AS t, count(*)::int AS n FROM events
        WHERE name = 'session_started' AND occurred_at >= $1::timestamptz GROUP BY 1`, [start, step]),
    db.query(
      `SELECT ${B('created_at')} AS t, count(*)::int AS n FROM event_log
        WHERE kind = 'site_sign_in' AND created_at >= $1::timestamptz GROUP BY 1`, [start, step]),
    db.query(
      `SELECT ${B('paid_at')} AS t, count(*)::int AS n, sum(amount_paise)::bigint AS paise
         FROM payments p WHERE ${WEB_PAID} AND paid_at >= $1::timestamptz GROUP BY 1`, [start, step]),
    // Today's totals, whatever the window.
    db.one(
      `WITH c AS (SELECT ${CHECK_OUTCOME} AS outcome FROM event_log WHERE created_at >= to_timestamp($1) AND ${WEB_CHECK_KINDS})
       SELECT (SELECT count(*) FROM events WHERE name = 'session_started' AND occurred_at >= to_timestamp($1))::int AS visits,
              (SELECT count(*) FROM c WHERE outcome = 'checked')::int AS checked,
              (SELECT count(*) FROM c WHERE outcome = 'not_found')::int AS not_found,
              (SELECT count(*) FROM c WHERE outcome = 'failed')::int AS failed,
              (SELECT count(*) FROM event_log WHERE kind = 'site_sign_in' AND created_at >= to_timestamp($1))::int AS sign_ins,
              (SELECT count(*) FROM payments p WHERE ${WEB_PAID} AND paid_at >= to_timestamp($1))::int AS paid,
              (SELECT coalesce(sum(amount_paise), 0) FROM payments p WHERE ${WEB_PAID} AND paid_at >= to_timestamp($1))::bigint AS revenue_paise`,
      [Number(mid.t)]),
    // The latest moments, newest first.
    db.query(
      `(SELECT e.created_at AS at, ${CHECK_OUTCOME.replace(/detail/g, 'e.detail')} AS step, e.detail->>'reg_no' AS reg_no,
               coalesce(u.mobile, e.detail->>'mobile') AS mobile, NULL::bigint AS paise
          FROM event_log e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.created_at >= $1::timestamptz AND ${WEB_CHECK_KINDS.replace(/kind/g, 'e.kind').replace(/detail/g, 'e.detail')}
         ORDER BY e.created_at DESC LIMIT 30)
       UNION ALL
       (SELECT e.created_at, 'sign_in', NULL, e.detail->>'mobile', NULL
          FROM event_log e WHERE e.kind = 'site_sign_in' AND e.created_at >= $1::timestamptz ORDER BY e.created_at DESC LIMIT 15)
       UNION ALL
       (SELECT p.paid_at, 'paid', NULL, u.mobile, p.amount_paise
          FROM payments p LEFT JOIN users u ON u.id = p.user_id
         WHERE ${WEB_PAID} AND p.paid_at >= $1::timestamptz ORDER BY p.paid_at DESC LIMIT 10)
       ORDER BY at DESC LIMIT 30`, [start]),
  ]);

  // Every bucket from the start to now, zeros included, so the line moves on.
  const now = Math.floor(Date.now() / 1000 / step) * step;
  const by = new Map();
  for (let t = Math.floor(startEpoch / step) * step; t <= now; t += step) {
    by.set(t, { t: new Date(t * 1000).toISOString(), visits: 0, checked: 0, not_found: 0, failed: 0, sign_ins: 0, paid: 0, revenue_paise: 0 });
  }
  for (const r of checks.rows) { const b = by.get(Number(r.t)); if (b) b[r.outcome] += r.n; }
  for (const r of visits.rows) { const b = by.get(Number(r.t)); if (b) b.visits += r.n; }
  for (const r of signIns.rows) { const b = by.get(Number(r.t)); if (b) b.sign_ins += r.n; }
  for (const r of pay.rows) { const b = by.get(Number(r.t)); if (b) { b.paid += r.n; b.revenue_paise += Number(r.paise || 0); } }
  const names = feed.rows.length ? await db.query(
    `SELECT mobile, coalesce(display_name, wa_profile_name) AS name FROM users WHERE mobile = ANY($1::text[])`,
    [[...new Set(feed.rows.map((r) => r.mobile).filter(Boolean))]]) : { rows: [] };
  const nameOf = new Map(names.rows.map((r) => [r.mobile, r.name]));
  return {
    window: w in WINDOWS ? w : 'today', label: win.label, bucket_minutes: win.bucket,
    series: [...by.values()],
    totals: { ...totals, revenue_paise: Number(totals.revenue_paise) },
    feed: feed.rows.map((r) => ({
      at: r.at, step: r.step, reg_no: r.reg_no, paise: r.paise == null ? null : Number(r.paise),
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

const PAGES = { overview, funnel, money, customers, vehicles, services, today };
const DRILLS = {
  overview: overviewDay, funnel: funnelStep, money: moneyDay, customers: customersOf,
  vehicles: vehiclesOf, services: servicesOf,
};

module.exports = { PAGES, DRILLS };
