/**
 * src/admin/graphs.js — the numbers behind the admin's Graphs section (user,
 * 2026-10-03: "a separate main option for graphs only … nested graphs").
 *
 * Seven pages, each a set of daily series over the last 7, 30 or 90 days (IST
 * days, every day present — a quiet day is a zero, not a gap) and a drill-down
 * for the mark that was clicked:
 *
 *   overview   customers, checks (distinct / repeat), full reports, revenue  → a day by hour
 *   funnel     hi → agreed → number → free check → tapped ₹19 → link → paid  → who stopped at a step
 *   money      revenue, GST, gateway fee, API, WhatsApp, ads, what is left   → a day's payments
 *   customers  new vs returning, STOP vs back, where they came from, why STOP → the people
 *   vehicles   checks by state, type / fuel / make, documents expiring       → state → RTO → vehicles
 *   whatsapp   messages in / out, template cost by category                  → a day by message type
 *   services   provider calls answered / failed, speed, RC backup spend      → a provider's errors
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

const CHECKS = `kind IN ('vehicle_check', 'vehicle_check_repeat')`;
const PAID = `p.status = 'paid' AND p.amount_paise > 0`;
const mask = (m) => (m ? `••••••${String(m).slice(-4)}` : null);

/* ─────────────────────────────── overview ─────────────────────────────── */

async function overview({ days }) {
  const n = span(days);
  const { rows } = await db.query(
    `WITH ${DAYS},
       u AS (SELECT ${dayOf('created_at')} AS d, count(*) AS n FROM users WHERE ${since('created_at')} GROUP BY 1),
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
  return { days: n, series: rows.map((x) => ({ ...x, d: iso(x.d), revenue_paise: Number(x.revenue_paise) })) };
}

/** One day, hour by hour — the drill-down under a day on the overview. */
async function overviewDay({ day }) {
  if (!isDay(day)) return { hours: [] };
  const { rows } = await db.query(
    `WITH h AS (SELECT generate_series(0, 23) AS h),
       u AS (SELECT extract(hour FROM created_at ${IST})::int AS h, count(*) AS n FROM users
              WHERE ${dayOf('created_at')} = $1::date GROUP BY 1),
       c AS (SELECT extract(hour FROM created_at ${IST})::int AS h, count(*) AS n FROM event_log
              WHERE ${CHECKS} AND ${dayOf('created_at')} = $1::date GROUP BY 1),
       r AS (SELECT extract(hour FROM r.created_at ${IST})::int AS h, count(*) AS n FROM vehicle_reports r JOIN payments p ON p.id = r.payment_id
              WHERE ${PAID} AND ${dayOf('r.created_at')} = $1::date GROUP BY 1)
     SELECT h.h, coalesce(u.n, 0)::int AS customers, coalesce(c.n, 0)::int AS checks, coalesce(r.n, 0)::int AS reports
       FROM h LEFT JOIN u USING (h) LEFT JOIN c USING (h) LEFT JOIN r USING (h) ORDER BY h.h`, [day]);
  return { day, hours: rows };
}

/* ──────────────────────────────── funnel ──────────────────────────────── */

const STEPS = [
  ['hi', 'Said hi'], ['agreed', 'Agreed to terms'], ['number', 'Sent a number'], ['basic_shown', 'Saw the free check'],
  ['buy_tapped', 'Tapped ₹19'], ['link_sent', 'Got the payment link'], ['paid', 'Paid'],
];

/* Who reached each step in the period, by mobile. "Paid" is a paid payment. */
const REACHED = `
  SELECT detail->>'step' AS step, detail->>'mobile' AS mobile, max(created_at) AS at
    FROM event_log WHERE kind = 'funnel' AND detail->>'step' = ANY($2::text[]) AND ${since('created_at')}
   GROUP BY 1, 2
  UNION ALL
  SELECT 'paid', u.mobile, max(p.paid_at) FROM payments p JOIN users u ON u.id = p.user_id
   WHERE ${PAID} AND ${since('p.paid_at')} GROUP BY 2`;

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
    note: 'GST from the rate in force; the gateway fee estimated at the fee % in Settings; WhatsApp at the per-category rates.',
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

const SOURCE = `CASE WHEN ws.attribution->>'channel' = 'whatsapp_ad' THEN 'WhatsApp ads'
                     WHEN u.signup_channel = 'web' OR EXISTS (SELECT 1 FROM visitors v WHERE v.mobile = u.mobile) THEN 'Website'
                     ELSE 'WhatsApp direct' END`;

async function customers({ days }) {
  const n = span(days);
  const [daily, sources, reasons] = await Promise.all([
    db.query(
      `WITH ${DAYS},
         nu AS (SELECT ${dayOf('created_at')} AS d, count(*) AS n FROM users WHERE ${since('created_at')} GROUP BY 1),
         act AS (SELECT ${dayOf('e.occurred_at')} AS d, count(DISTINCT e.user_id) AS n FROM events e JOIN users u ON u.id = e.user_id
                  WHERE ${since('e.occurred_at')} AND ${dayOf('u.created_at')} < ${dayOf('e.occurred_at')} GROUP BY 1),
         st AS (SELECT ${dayOf('created_at')} AS d, count(*) FILTER (WHERE detail->>'step' = 'opt_out') AS stops,
                       count(*) FILTER (WHERE detail->>'step' = 'opt_in') AS back
                  FROM event_log WHERE kind = 'funnel' AND detail->>'step' IN ('opt_out', 'opt_in') AND ${since('created_at')} GROUP BY 1)
       SELECT days.d, coalesce(nu.n, 0)::int AS new, coalesce(act.n, 0)::int AS returning,
              coalesce(st.stops, 0)::int AS stops, coalesce(st.back, 0)::int AS back
         FROM days LEFT JOIN nu USING (d) LEFT JOIN act USING (d) LEFT JOIN st USING (d) ORDER BY days.d`, [n]),
    db.query(
      `SELECT ${SOURCE} AS source, count(*)::int AS n
         FROM users u LEFT JOIN whatsapp_sessions ws ON ws.mobile = u.mobile
        WHERE ${since('u.created_at')} GROUP BY 1 ORDER BY 2 DESC`, [n]),
    db.query(
      `SELECT detail->>'reason' AS reason, count(*)::int AS n FROM event_log
        WHERE kind = 'funnel' AND detail->>'step' = 'opt_out_reason' AND ${since('created_at')}
        GROUP BY 1 ORDER BY 2 DESC`, [n]),
  ]);
  return { days: n, series: daily.rows.map((x) => ({ ...x, d: iso(x.d) })), sources: sources.rows, reasons: reasons.rows };
}

/** The people behind a source or a STOP reason. */
async function customersOf({ days, source, reason }) {
  const n = span(days);
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
    `SELECT u.mobile, u.created_at AS at, coalesce(u.display_name, u.wa_profile_name) AS name
       FROM users u LEFT JOIN whatsapp_sessions ws ON ws.mobile = u.mobile
      WHERE ${since('u.created_at')} AND ${SOURCE} = $2 ORDER BY u.created_at DESC LIMIT 100`, [n, String(source || '')]);
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

async function whatsapp({ days }) {
  const n = span(days);
  const R = await ledger.rates();
  const cat = `upper(coalesce((SELECT t.category FROM wa_templates t WHERE t.template_name = m.template_name LIMIT 1), ''))`;
  const { rows } = await db.query(
    `WITH ${DAYS},
       x AS (SELECT ${dayOf('m.created_at')} AS d,
                    count(*) FILTER (WHERE m.direction = 'in') AS inbound,
                    count(*) FILTER (WHERE m.direction = 'out' AND m.message_type <> 'template') AS replies,
                    count(*) FILTER (WHERE m.direction = 'out' AND m.message_type = 'template') AS templates,
                    count(DISTINCT m.mobile) FILTER (WHERE m.direction = 'in') AS people,
                    coalesce(sum(CASE WHEN m.direction = 'out' AND m.message_type = 'template' AND ${cat} = 'MARKETING' THEN ${Number(R.wa_marketing_paise) || 0} END), 0) AS marketing,
                    coalesce(sum(CASE WHEN m.direction = 'out' AND m.message_type = 'template' AND ${cat} = 'UTILITY' THEN ${Number(R.wa_utility_paise) || 0} END), 0) AS utility,
                    coalesce(sum(CASE WHEN m.direction = 'out' AND m.message_type = 'template' AND ${cat} NOT IN ('MARKETING', 'UTILITY') THEN ${Number(R.wa_rate_paise) || 0} END), 0) AS other
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
  return {
    days: n, providers: totals.rows, series: Object.values(byDay),
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

/* ─────────────────────────────── helpers ──────────────────────────────── */

function iso(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

const PAGES = { overview, funnel, money, customers, vehicles, whatsapp, services };
const DRILLS = {
  overview: overviewDay, funnel: funnelStep, money: moneyDay, customers: customersOf,
  vehicles: vehiclesOf, whatsapp: whatsappDay, services: servicesOf,
};

module.exports = { PAGES, DRILLS };
