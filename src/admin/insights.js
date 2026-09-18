/**
 * src/admin/insights.js — the analytics the panel draws, beyond the time series.
 *
 *   compare()   today / this week / this month against the period before, both
 *               to the same point (like for like) and in full.
 *   fleet()     every vehicle known, classified 2W / 3W / 4W / heavy, with the
 *               state of each of its documents, RC status, fuel, age and challans.
 *   heatmap()   when people check vehicles: weekday × hour, in IST.
 *
 * The fleet is read from each vehicle's latest RC snapshot, so it is the record
 * as last fetched — which is what a customer was shown — not a fresh lookup.
 */

const db = require('../db');
const { splitOf } = require('./stats');

const TZ = `'Asia/Kolkata'`;

/* ───────────────────────────────────────────────────────────── compare ── */

/* Everything counted in one window. $1 inclusive, $2 exclusive. */
const METRICS_SQL = `
  SELECT
    (SELECT count(*) FROM users WHERE created_at >= $1 AND created_at < $2)              AS new_users,
    (SELECT count(*) FROM event_log WHERE kind = 'vehicle_check'
        AND created_at >= $1 AND created_at < $2)                                         AS checks,
    (SELECT count(DISTINCT user_id) FROM event_log WHERE kind = 'vehicle_check'
        AND created_at >= $1 AND created_at < $2)                                         AS active_users,
    (SELECT count(*) FROM vehicles WHERE first_seen_at >= $1 AND first_seen_at < $2)     AS new_vehicles,
    (SELECT count(*) FROM site_sessions WHERE created_at >= $1 AND created_at < $2)      AS sign_ins,
    (SELECT count(*) FROM payments WHERE status = 'paid'
        AND paid_at >= $1 AND paid_at < $2)                                               AS payments,
    (SELECT coalesce(sum(amount_paise), 0) FROM payments WHERE status = 'paid'
        AND paid_at >= $1 AND paid_at < $2)                                               AS gross_paise,
    (SELECT count(*) FROM payments WHERE status = 'created'
        AND created_at >= $1 AND created_at < $2)                                         AS abandoned,
    (SELECT count(*) FROM vehicle_reports WHERE created_at >= $1 AND created_at < $2)    AS reports,
    (SELECT count(*) FROM feedback WHERE created_at >= $1 AND created_at < $2)           AS feedback,
    (SELECT count(*) FROM whatsapp_messages WHERE direction = 'out' AND message_type = 'template'
        AND created_at >= $1 AND created_at < $2)                                         AS wa_billed,
    (SELECT count(*) FROM site_otps WHERE created_at >= $1 AND created_at < $2)          AS sms_sent`;

async function metrics(from, to) {
  const r = await db.one(METRICS_SQL, [from, to]);
  const n = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v || 0)]));
  const money = await splitOf(n.gross_paise, { whatsapp: n.wa_billed, sms: n.sms_sent });
  return {
    ...n,
    take_home_paise: money.take_home_paise,
    gst_paise: money.gst_paise,
    fees_paise: money.gateway_fee_paise + money.gateway_fee_gst_paise,
    messaging_paise: money.whatsapp_cost_paise + money.sms_cost_paise,
    avg_order_paise: n.payments ? Math.round(n.gross_paise / n.payments) : 0,
    conversion: n.active_users ? Math.round((n.payments / n.active_users) * 1000) / 10 : 0,
  };
}

/**
 * Each period to now, against the one before: to the same point (this morning
 * against yesterday morning — the fair comparison while the day is running)
 * and in full (the whole of yesterday).
 */
async function compare() {
  const b = await db.one(
    `WITH l AS (SELECT now() AT TIME ZONE ${TZ} AS t)
     SELECT now() AS now,
            date_trunc('day', t)   AT TIME ZONE ${TZ} AS day0,
            (date_trunc('day', t)   - interval '1 day')   AT TIME ZONE ${TZ} AS day_prev,
            date_trunc('week', t)  AT TIME ZONE ${TZ} AS week0,
            (date_trunc('week', t)  - interval '1 week')  AT TIME ZONE ${TZ} AS week_prev,
            date_trunc('month', t) AT TIME ZONE ${TZ} AS month0,
            (date_trunc('month', t) - interval '1 month') AT TIME ZONE ${TZ} AS month_prev
       FROM l`);

  const out = {};
  for (const p of ['day', 'week', 'month']) {
    const start = new Date(b[`${p}0`]);
    const prevStart = new Date(b[`${p}_prev`]);
    const now = new Date(b.now);
    const elapsed = now - start;
    const prevSamePoint = new Date(Math.min(prevStart.getTime() + elapsed, start.getTime()));
    const [current, samePoint, full] = await Promise.all([
      metrics(start, now), metrics(prevStart, prevSamePoint), metrics(prevStart, start),
    ]);
    out[p] = {
      current: { from: start, to: now, ...current },
      previous_same_point: { from: prevStart, to: prevSamePoint, ...samePoint },
      previous_full: { from: prevStart, to: start, ...full },
      elapsed_fraction: Math.round((elapsed / (start - prevStart)) * 1000) / 1000,
    };
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────── fleet ── */

const GROUPS = [
  { key: '2W', label: 'Two-wheelers' },
  { key: '3W', label: 'Three-wheelers' },
  { key: '4W', label: 'Four-wheelers (light)' },
  { key: 'HV', label: 'Multi-axle / heavy' },
  { key: 'OT', label: 'Other / not recorded' },
];

/*
 * VAHAN's class and category, read together. The category (LIGHT / MEDIUM /
 * HEAVY, TWO / THREE WHEELER) is the reliable part; the class ("Goods Carrier")
 * is shared by a pick-up and a 12-wheeler, so it only decides when the
 * category is silent. A gross weight over 7.5 tonnes is heavy whatever it says.
 */
function groupOf(rc) {
  const cat = String(rc.vehicle_category || '').toUpperCase();
  const all = `${rc.vehicle_class || ''} ${cat} ${rc.body_type || ''}`.toUpperCase();
  if (/TWO.?WHEELER|\b2W[NT]\b|M-?CYCLE|SCOOTER|MOPED|MOTOR ?CYCLE/.test(all)) return '2W';
  if (/THREE.?WHEELER|\b3W[NT]\b|E-?RICKSHAW|E-?CART|AUTO.?RICKSHAW/.test(all)) return '3W';
  if (Number(rc.gross_weight) > 7500 || /HEAVY|MEDIUM|\b[HM][GP]V\b/.test(cat)) return 'HV';
  if (/LIGHT|\bL[MGP]V\b/.test(cat)) return '4W';
  if (/BUS|TRUCK|LORRY|TIPPER|TANKER|TRAILER|ARTICULATED|MULTI.?AXLE|CRANE|TRACTOR|DUMPER|EXCAVATOR/.test(all)) return 'HV';
  if (/MOTOR CAR|JEEP|CAB|TAXI|OMNI|VAN|PICK.?UP|L\.?M\.?V|STATION WAGON|SALOON|HATCH|SUV|SEDAN/.test(all)) return '4W';
  return 'OT';
}

const DOCS = [
  ['insurance', 'Insurance', 'insurance_upto'],
  ['pucc', 'PUC', 'pucc_upto'],
  ['fitness', 'Fitness', 'fitness_upto'],
  ['tax', 'Road tax', 'tax_upto'],
  ['permit', 'Permit', 'permit_upto'],
  ['registration', 'Registration', 'reg_upto'],
];
const STATES = ['expired', 'due', 'valid', 'none'];
const SOON = 30;

/* VAHAN writes 2026-05-01, 01-05-2026 or 01/05/2026 depending on the field. */
function dayOf(v) {
  const t = String(v || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(t);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  return null;
}

function yearOf(manufactured) {
  const m = /(\d{4})/.exec(String(manufactured || ''));
  return m ? Number(m[1]) : null;
}

async function fleet() {
  const { rows } = await db.query(
    `SELECT v.id, v.reg_no, v.first_seen_at, v.last_seen_at,
            rc.data AS rc, rc.fetched_at AS rc_fetched_at,
            (ch.data->>'pending_count')::int            AS challans_pending,
            (ch.data->>'pending_amount_paise')::bigint  AS challans_amount_paise,
            EXISTS (SELECT 1 FROM vehicle_reports r WHERE r.vehicle_id = v.id)            AS paid,
            EXISTS (SELECT 1 FROM watches w WHERE w.vehicle_id = v.id AND w.is_active)    AS watched,
            (SELECT count(DISTINCT e.user_id) FROM event_log e
              WHERE e.vehicle_id = v.id AND e.kind = 'vehicle_check')                     AS checked_by,
            EXISTS (SELECT 1 FROM blocks b WHERE b.kind = 'vehicle' AND b.value = v.reg_no
                      AND b.released_at IS NULL)                                          AS blocked
       FROM vehicles v
       LEFT JOIN vehicle_snapshots rc ON rc.vehicle_id = v.id AND rc.dataset = 'rc'
       LEFT JOIN vehicle_snapshots ch ON ch.vehicle_id = v.id AND ch.dataset = 'challan'
      ORDER BY v.last_seen_at DESC NULLS LAST
      LIMIT 20000`);

  const today = Date.UTC(...(() => {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  })());
  const thisYear = new Date().getFullYear();

  const vehicles = rows.map((r) => {
    const rc = r.rc || {};
    const docs = {};
    let worst = 'none';
    const rank = { expired: 3, due: 2, valid: 1, none: 0 };
    for (const [key, , field] of DOCS) {
      const at = dayOf(rc[field]);
      const days = at == null ? null : Math.round((at - today) / 86400000);
      const state = days == null ? 'none' : days < 0 ? 'expired' : days <= SOON ? 'due' : 'valid';
      docs[key] = { state, date: rc[field] || null, days };
      if (rank[state] > rank[worst]) worst = state;
    }
    const year = yearOf(rc.manufactured);
    return {
      reg_no: r.reg_no,
      group: r.rc ? groupOf(rc) : 'OT',
      maker: rc.maker || null,
      model: rc.model || null,
      vehicle_class: rc.vehicle_class || null,
      category: rc.vehicle_category || null,
      fuel: rc.fuel || null,
      status: rc.status || null,
      norms: rc.norms || null,
      manufactured: rc.manufactured || null,
      age_years: year ? thisYear - year : null,
      rto: rc.registered_at || null,
      state_code: rc.state_code || String(r.reg_no).slice(0, 2),
      financed: Boolean(rc.financer),
      owner_serial: rc.owner_serial || null,
      docs,
      worst,
      challans_pending: Number(r.challans_pending || 0),
      challans_amount_paise: Number(r.challans_amount_paise || 0),
      paid: r.paid, watched: r.watched, blocked: r.blocked,
      checked_by: Number(r.checked_by || 0),
      first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at,
      rc_fetched_at: r.rc_fetched_at,
    };
  });

  /* Tallies the page draws from; the page also filters `vehicles` itself for
     the drill-downs, so a tap costs no round trip. */
  const tally = (list, keyOf) => {
    const m = new Map();
    for (const v of list) { const k = keyOf(v) || 'Not recorded'; m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  };
  const statusWord = (s) => (!s ? 'Not recorded' : /^active$/i.test(s) ? 'Active' : s.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w+/g, (w) => w.toLowerCase()));
  const fuelWord = (f) => (!f ? null : /petrol.*cng|cng.*petrol/i.test(f) ? 'Petrol/CNG'
    : /electric|battery|bov/i.test(f) ? 'Electric' : /hybrid/i.test(f) ? 'Hybrid'
    : f.replace(/\b\w+/g, (w) => w.charAt(0) + w.slice(1).toLowerCase()));
  const ageBand = (a) => (a == null ? null : a < 3 ? '0–2 yrs' : a < 6 ? '3–5 yrs' : a < 11 ? '6–10 yrs' : a < 16 ? '11–15 yrs' : '15+ yrs');

  const groups = GROUPS.map((g) => {
    const list = vehicles.filter((v) => v.group === g.key);
    const worst = Object.fromEntries(STATES.map((s) => [s, list.filter((v) => v.worst === s).length]));
    return {
      ...g,
      total: list.length,
      active: list.filter((v) => /^active$/i.test(v.status || '')).length,
      paid: list.filter((v) => v.paid).length,
      watched: list.filter((v) => v.watched).length,
      with_challans: list.filter((v) => v.challans_pending > 0).length,
      challans_pending: list.reduce((t, v) => t + v.challans_pending, 0),
      challans_amount_paise: list.reduce((t, v) => t + v.challans_amount_paise, 0),
      worst,
      docs: Object.fromEntries(DOCS.map(([key]) => [key,
        Object.fromEntries(STATES.map((s) => [s, list.filter((v) => v.docs[key].state === s).length]))])),
    };
  });

  /* What is coming due: documents by the week they lapse, next 12 weeks. */
  const upcoming = Array.from({ length: 12 }, (_, i) => ({ week: i, label: i === 0 ? 'This week' : `+${i}w` }));
  for (const v of vehicles) {
    for (const [key] of DOCS) {
      const d = v.docs[key].days;
      if (d != null && d >= 0 && d < 84) {
        const w = upcoming[Math.floor(d / 7)];
        w[key] = (w[key] || 0) + 1;
      }
    }
  }

  /* How long ago the expired ones lapsed. */
  const lapsedBands = [['≤ 30 days', 30], ['1–3 months', 91], ['3–6 months', 182], ['6–12 months', 365], ['1 year +', Infinity]];
  const lapsed = lapsedBands.map(([label]) => ({ label }));
  for (const v of vehicles) {
    for (const [key] of DOCS) {
      const d = v.docs[key].days;
      if (d != null && d < 0) {
        const i = lapsedBands.findIndex(([, max]) => -d <= max);
        lapsed[i][key] = (lapsed[i][key] || 0) + 1;
      }
    }
  }

  return {
    as_of: new Date().toISOString(),
    soon_days: SOON,
    total: vehicles.length,
    groups,
    documents: DOCS.map(([key, label]) => ({
      key, label,
      ...Object.fromEntries(STATES.map((s) => [s, vehicles.filter((v) => v.docs[key].state === s).length])),
    })),
    status: tally(vehicles, (v) => statusWord(v.status)),
    fuel: tally(vehicles, (v) => fuelWord(v.fuel)),
    makers: tally(vehicles, (v) => v.maker && v.maker.replace(/\s+(PVT\.?|PRIVATE|LTD\.?|LIMITED|INDIA|MOTORS?|CO\.?)\b.*$/i, '').trim()).slice(0, 12),
    age: ['0–2 yrs', '3–5 yrs', '6–10 yrs', '11–15 yrs', '15+ yrs', 'Not recorded']
      .map((name) => ({ name, count: vehicles.filter((v) => (ageBand(v.age_years) || 'Not recorded') === name).length })),
    states: tally(vehicles, (v) => v.state_code).slice(0, 15),
    norms: tally(vehicles, (v) => v.norms).slice(0, 8),
    upcoming,
    lapsed,
    vehicles,
  };
}

/* ───────────────────────────────────────────────────────────── heatmap ── */

/** Checks by weekday (0 = Monday) and hour, IST, over the last `days`. */
async function heatmap({ days = 30 } = {}) {
  const { rows } = await db.query(
    `SELECT (extract(isodow FROM created_at AT TIME ZONE ${TZ})::int - 1) AS dow,
            extract(hour FROM created_at AT TIME ZONE ${TZ})::int         AS hour,
            count(*)::int AS checks
       FROM event_log
      WHERE kind = 'vehicle_check' AND created_at > now() - ($1 || ' days')::interval
      GROUP BY 1, 2`, [String(Math.min(365, Math.max(1, days)))]);
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of rows) grid[r.dow][r.hour] = r.checks;
  return { days, grid, max: Math.max(0, ...rows.map((r) => r.checks)) };
}

module.exports = { compare, fleet, heatmap, groupOf };
