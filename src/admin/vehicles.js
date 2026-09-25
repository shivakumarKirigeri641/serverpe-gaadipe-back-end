/**
 * src/admin/vehicles.js — the admin Vehicles module (user, 2026-09-25):
 * "search for ANY vehicle used on GaadiPe and see everything we know about it".
 * ---------------------------------------------------------------------------
 *   list(q, admin)       the explorer: server-side search, filters, sort and
 *                        pages over every vehicle, one row each
 *   stats()              unique vehicles today / yesterday / 7 / 30 days and
 *                        against the period before; paid, unpaid, repeat …
 *   quick(term)          the header's global search — five best matches
 *   profile(reg, opts)   one vehicle, whole: what the records API returned,
 *                        documents, challans, blacklist / NOC, financier,
 *                        every lookup, customer, WhatsApp and website step,
 *                        payment, report and API call, one merged timeline,
 *                        notes, tags and its audit history
 *   reveal(...)          a customer's full mobile or the RC owner — audited
 *   exportCsv(q, fields) the explorer's rows as CSV
 *
 * NOTHING HERE IS INVENTED. A field the provider did not return is null and the
 * panel says "Not available"; a vehicle never looked up says "Unknown". No
 * financier on record is not "no loan", and no challan snapshot is not "no
 * challans".
 *
 * MOBILES ARE MASKED BY DEFAULT, for every role (XXXXXX1234); the full number
 * is one audited reveal away for vehicles.view_sensitive. The RC owner's name
 * and address likewise. Referral is left out: GaadiPe has none for now (user,
 * 2026-09-25).
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');
const db = require('../db');
const plate = require('../util/plate');
const settings = require('../util/settings');
const command = require('./command');
const ledger = require('../finance/ledger');

const LOOKUP_NAMES = `('vehicle_search_success', 'vehicle_search_failed')`;
const IST_TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/** 9886122415 -> XXXXXX2415. */
const maskMobile = (m) => {
  const d = String(m ?? '').replace(/\D/g, '');
  return d.length >= 10 ? `XXXXXX${d.slice(-4)}` : (m ? 'XXXXXX' : null);
};
/** "RAMESH KUMAR" -> "R***** K****". */
const maskName = (n) => (n ? String(n).replace(/\S+/g, (w) => w[0] + '*'.repeat(Math.max(1, w.length - 1))) : null);
/** A stable handle for one customer of one vehicle, without the number in it. */
const refOf = (vehicleId, mobile) => `m${crypto.createHash('sha256').update(`${vehicleId}:${mobile}`).digest('hex').slice(0, 14)}`;

/* The documents with an expiry, their column on vehicles, and the RC fields that describe them. */
const DOCS = [
  ['insurance', 'Insurance', 'insurance_upto'],
  ['puc', 'PUC', 'pucc_upto'],
  ['tax', 'Road tax', 'tax_upto'],
  ['permit', 'Permit', 'permit_upto'],
  ['fitness', 'Fitness', 'fitness_upto'],
];
/* pg hands a DATE back as local midnight; keep it the calendar day it is. */
const ymd = (d) => {
  if (d == null || d === '') return null;
  if (d instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  const t = String(d).trim();
  if (/^d{4}-d{2}-d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(d{1,2})[-/](d{1,2})[-/](d{4})/);   // 31-03-2025
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};
const soonDays = () => settings.num('vehicle_expiring_days', 30);

/* valid | soon | expired | na (the provider gave no date) | unknown (never looked up). */
const docState = (col) => `CASE WHEN x.rc_checked_at IS NULL AND x.${col} IS NULL THEN 'unknown'
  WHEN x.${col} IS NULL THEN 'na'
  WHEN x.${col} < ${IST_TODAY} THEN 'expired'
  WHEN x.${col} < ${IST_TODAY} + $1::int THEN 'soon' ELSE 'valid' END`;

/* ─────────────────────────────── the explorer ─────────────────────────────── */

/*
 * One row per vehicle with everything the table and its filters need. Each
 * aggregate is a LATERAL over an index keyed by the vehicle (events_reg_idx,
 * idx_reports_reg, idx_api_calls_reg, idx_payments_vehicle), so the page asked
 * for is what is computed — never thousands of rows sent to the browser.
 */
const BASE = `
  SELECT v.id, v.reg_no, v.maker, v.model, v.fuel, v.vehicle_class, v.rc_status,
         v.insurance_upto, v.pucc_upto, v.tax_upto, v.permit_upto, v.fitness_upto,
         v.financer, v.blacklist_status, v.first_seen_at, v.last_seen_at,
         upper(substring(v.reg_no from 1 for 2)) AS state,
         CASE WHEN v.reg_no ~ '^[A-Z]{2}[0-9]{2}' THEN substring(v.reg_no from 1 for 4)
              ELSE substring(v.reg_no from 1 for 2) END AS rto,
         rc.fetched_at AS rc_checked_at, rc.data->>'vehicle_category' AS category,
         rc.data->>'registered_at' AS registered_at,
         ch.fetched_at AS challan_checked_at,
         CASE WHEN ch.data IS NULL THEN NULL ELSE coalesce((ch.data->>'pending_count')::int, 0) END AS challans_pending,
         CASE WHEN ch.data IS NULL THEN NULL ELSE coalesce((ch.data->>'pending_count')::int, 0)
                                                 + coalesce((ch.data->>'disposed_count')::int, 0) END AS challans_total,
         lk.lookups, lk.first_lookup, lk.last_lookup, lk.wa_lookups, lk.web_lookups, lk.failed_lookups, lk.customers,
         last.channel AS last_channel, last.person AS last_person,
         rp.reports, rp.last_report_at,
         py.paid, py.pay_failed, py.pay_pending, py.paid_paise, py.last_paid_at,
         ap.api_calls, ap.api_failed, ap.api_last_at,
         va.assigned_to, va.archived_at, au.name AS assigned_name,
         coalesce(tg.tags, '{}') AS tags,
         greatest(v.last_seen_at, lk.last_lookup, rp.last_report_at, py.last_paid_at) AS last_activity
    FROM vehicles v
    LEFT JOIN vehicle_snapshots rc ON rc.vehicle_id = v.id AND rc.dataset = 'rc'
    LEFT JOIN vehicle_snapshots ch ON ch.vehicle_id = v.id AND ch.dataset = 'challan'
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS lookups, min(e.occurred_at) AS first_lookup, max(e.occurred_at) AS last_lookup,
             count(*) FILTER (WHERE e.channel = 'whatsapp')::int AS wa_lookups,
             count(*) FILTER (WHERE e.channel = 'web')::int AS web_lookups,
             count(*) FILTER (WHERE e.name = 'vehicle_search_failed')::int AS failed_lookups,
             count(DISTINCT coalesce(e.mobile, e.user_id::text, e.visitor_id))::int AS customers
        FROM events e WHERE e.reg_no = v.reg_no AND e.name IN ${LOOKUP_NAMES}) lk ON true
    LEFT JOIN LATERAL (
      SELECT e.channel, coalesce(e.mobile, u.mobile) AS person
        FROM events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.reg_no = v.reg_no AND e.name IN ${LOOKUP_NAMES}
       ORDER BY e.occurred_at DESC LIMIT 1) last ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS reports, max(r.created_at) AS last_report_at
        FROM vehicle_reports r WHERE r.reg_no = v.reg_no) rp ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE p.status = 'paid')::int AS paid,
             count(*) FILTER (WHERE p.status = 'failed')::int AS pay_failed,
             count(*) FILTER (WHERE p.status = 'created')::int AS pay_pending,
             coalesce(sum(p.amount_paise) FILTER (WHERE p.status = 'paid'), 0)::bigint AS paid_paise,
             max(p.paid_at) AS last_paid_at
        FROM payments p WHERE p.raw ? 'vehicle_id' AND p.raw->>'vehicle_id' = v.id::text) py ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS api_calls, count(*) FILTER (WHERE NOT a.ok)::int AS api_failed, max(a.created_at) AS api_last_at
        FROM api_calls a WHERE a.reg_no = v.reg_no) ap ON true
    LEFT JOIN vehicle_admin va ON va.vehicle_id = v.id
    LEFT JOIN admin_users au ON au.id = va.assigned_to
    LEFT JOIN LATERAL (SELECT array_agg(t.tag ORDER BY t.tag) AS tags FROM vehicle_tags t WHERE t.vehicle_id = v.id) tg ON true`;

const WITH_STATES = `
  SELECT x.*, ${DOCS.map(([k, , col]) => `${docState(col)} AS ${k}_state`).join(', ')},
         (${DOCS.map(([, , col]) => `coalesce((x.${col} < ${IST_TODAY})::int, 0)`).join(' + ')}) AS expired_docs
    FROM (${BASE}) x`;

const SORTS = {
  reg_no: 'reg_no', maker: 'maker', model: 'model', first_seen: 'first_seen_at', last_seen: 'last_activity',
  lookups: 'lookups', reports: 'reports', paid: 'paid', expired: 'expired_docs', challans: 'challans_pending',
  customers: 'customers', revenue: 'paid_paise',
};
const STATES = ['valid', 'soon', 'expired', 'na', 'unknown'];

/** The views the sidebar links to — each a preset of the same filters. */
const VIEWS = {
  recent: { sort: 'last_seen' },
  paid: { paid: 'yes' },
  unpaid: { paid: 'no', report: '' },
  whatsapp: { channel: 'whatsapp' },
  web: { channel: 'web' },
  expired: { expired_min: '1' },
  challans: { challan: 'pending' },
  blacklisted: { blacklist: 'flagged' },
  loan: { loan: 'financier' },
};

/**
 * Turn the query string into WHERE clauses. Every value is a bind parameter;
 * the only text spliced in comes from the whitelists above.
 */
function whereOf(q, admin, args) {
  const w = [];
  const bind = (v) => { args.push(v); return `$${args.length}`; };
  const term = String(q.q || '').trim();

  if (term) {
    const digits = term.replace(/[\s+()-]/g, '');
    if (/^rpt/i.test(term)) {
      w.push(`x.reg_no IN (SELECT reg_no FROM vehicle_reports WHERE report_number ILIKE ${bind(`${term}%`)})`);
    } else if (/^(pay|order)_/i.test(term)) {
      w.push(`x.id::text IN (SELECT raw->>'vehicle_id' FROM payments WHERE payment_id = ${bind(term)} OR order_id = ${bind(term)})`);
    } else if (/^\d{5,13}$/.test(digits)) {
      // A customer's number (or its last digits): the vehicles they looked up.
      const tail = bind(`%${digits.slice(-10)}`);
      w.push(`(x.reg_no IN (SELECT e.reg_no FROM events e LEFT JOIN users u ON u.id = e.user_id
                             WHERE e.reg_no IS NOT NULL AND coalesce(e.mobile, u.mobile) LIKE ${tail})
            OR x.id IN (SELECT uv.vehicle_id FROM user_vehicles uv JOIN users u ON u.id = uv.user_id WHERE u.mobile LIKE ${tail}))`);
    } else {
      const p = plate.normalize(term);
      if (p) w.push(q.exact === '1' ? `x.reg_no = ${bind(p)}` : `x.reg_no LIKE ${bind(`%${p}%`)}`);
    }
  }

  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  if (day(q.from)) w.push(`x.last_activity >= (${bind(day(q.from))}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  if (day(q.to)) w.push(`x.last_activity < ((${bind(day(q.to))}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);

  if (q.state) w.push(`x.state = ${bind(String(q.state).toUpperCase().slice(0, 2))}`);
  if (q.rto) w.push(`x.rto = ${bind(plate.normalize(q.rto))}`);
  for (const k of ['maker', 'model', 'fuel']) if (q[k]) w.push(`x.${k} ILIKE ${bind(`%${String(q[k]).trim()}%`)}`);
  if (q.vclass) w.push(`(x.vehicle_class ILIKE ${bind(`%${String(q.vclass).trim()}%`)} OR x.category ILIKE $${args.length})`);

  if (q.channel === 'whatsapp') w.push('x.wa_lookups > 0');
  if (q.channel === 'web') w.push(`(x.web_lookups > 0 OR x.reg_no IN (SELECT reg_no FROM vehicle_reports WHERE channel = 'web'))`);
  if (q.paid === 'yes') w.push('x.paid > 0');
  if (q.paid === 'no') w.push('x.paid = 0');
  if (q.report === 'yes') w.push('x.reports > 0');
  if (q.report === 'no') w.push('x.reports = 0');
  if (q.payment === 'paid') w.push('x.paid > 0');
  if (q.payment === 'failed') w.push('x.pay_failed > 0');
  if (q.payment === 'pending') w.push('x.pay_pending > 0');
  if (q.payment === 'none') w.push('x.paid + x.pay_failed + x.pay_pending = 0');

  for (const [k] of DOCS) if (STATES.includes(q[k])) w.push(`x.${k}_state = ${bind(q[k])}`);
  if (Number(q.expired_min) > 0) w.push(`x.expired_docs >= ${bind(Math.min(5, Number(q.expired_min)))}`);

  if (q.challan === 'pending') w.push('x.challans_pending > 0');
  if (q.challan === 'none') w.push('x.challans_total = 0');
  if (q.challan === 'any') w.push('x.challans_total > 0');
  if (q.challan === 'unknown') w.push('x.challans_total IS NULL');
  if (q.blacklist === 'flagged') w.push(`coalesce(btrim(x.blacklist_status), '') <> ''`);
  if (q.blacklist === 'clear') w.push(`x.rc_checked_at IS NOT NULL AND coalesce(btrim(x.blacklist_status), '') = ''`);
  if (q.blacklist === 'unknown') w.push('x.rc_checked_at IS NULL');
  if (q.loan === 'financier') w.push(`coalesce(btrim(x.financer), '') <> ''`);
  if (q.loan === 'none_recorded') w.push(`x.rc_checked_at IS NOT NULL AND coalesce(btrim(x.financer), '') = ''`);
  if (q.loan === 'unknown') w.push('x.rc_checked_at IS NULL');
  if (q.api === 'failed') w.push('x.api_failed > 0');
  if (q.api === 'ok') w.push('x.api_calls > 0 AND x.api_failed = 0');
  if (q.repeat === '1') w.push('x.lookups >= 2');

  if (q.tag) w.push(`${bind(String(q.tag))} = ANY(x.tags)`);
  if (Number(q.list) > 0) w.push(`x.id IN (SELECT vehicle_id FROM vehicle_list_items WHERE list_id = ${bind(Number(q.list))})`);
  if (q.assigned === 'me') w.push(`x.assigned_to = ${bind(admin.id)}`);
  else if (q.assigned === 'anyone') w.push('x.assigned_to IS NOT NULL');
  else if (Number(q.assigned) > 0) w.push(`x.assigned_to = ${bind(Number(q.assigned))}`);
  // Archived vehicles leave the operational views; ask for them to see them.
  if (q.archived === 'only') w.push('x.archived_at IS NOT NULL');
  else if (q.archived !== 'all' && !(Number(q.list) > 0)) w.push('x.archived_at IS NULL');
  return w;
}

const rowOut = (r) => ({
  id: String(r.id), reg_no: r.reg_no, display: plate.pretty(r.reg_no),
  maker: r.maker, model: r.model, variant: null, fuel: r.fuel, vehicle_class: r.vehicle_class, category: r.category,
  state: r.state, rto: r.rto, registered_at: r.registered_at,
  first_seen: r.first_lookup && r.first_seen_at ? new Date(Math.min(new Date(r.first_lookup), new Date(r.first_seen_at))) : (r.first_lookup || r.first_seen_at),
  last_seen: r.last_activity,
  lookups: r.lookups, failed_lookups: r.failed_lookups, wa_lookups: r.wa_lookups, web_lookups: r.web_lookups,
  customers: r.customers, reports: r.reports, paid: r.paid, pay_failed: r.pay_failed, pay_pending: r.pay_pending,
  paid_paise: Number(r.paid_paise || 0),
  payment_status: r.paid > 0 ? 'paid' : r.pay_pending > 0 ? 'pending' : r.pay_failed > 0 ? 'failed' : 'none',
  last_channel: r.last_channel, customer: maskMobile(r.last_person),
  docs: Object.fromEntries(DOCS.map(([k, , col]) => [k, { state: r[`${k}_state`], upto: ymd(r[col]) }])),
  expired_docs: r.expired_docs, rc_status: r.rc_status,
  challans_pending: r.challans_pending, challans_total: r.challans_total,
  blacklisted: r.blacklist_status ? true : r.rc_checked_at ? false : null,
  financier: r.financer ? true : r.rc_checked_at ? false : null,
  api_calls: r.api_calls, api_failed: r.api_failed,
  rc_checked_at: r.rc_checked_at, assigned_to: r.assigned_to ? String(r.assigned_to) : null, assigned_name: r.assigned_name,
  archived: Boolean(r.archived_at), tags: r.tags,
});

async function list(q = {}, admin = {}) {
  const view = VIEWS[q.view] || {};
  const merged = { ...view, ...Object.fromEntries(Object.entries(q).filter(([, v]) => v !== '' && v != null)) };
  const args = [await soonDays()];
  const where = whereOf(merged, admin, args);
  const sortKey = SORTS[merged.sort] ? merged.sort : 'last_seen';
  const dir = merged.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
  const offset = Math.max(0, Number(q.offset) || 0);
  const { rows } = await db.query(
    `SELECT x.*, count(*) OVER () AS total_rows FROM (${WITH_STATES}) x
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY x.${SORTS[sortKey]} ${dir} NULLS LAST, x.id DESC
      LIMIT ${limit} OFFSET ${offset}`, args);
  return { total: rows[0] ? Number(rows[0].total_rows) : 0, rows: rows.map(rowOut), view: q.view || null, soon_days: args[0] };
}

/* ─────────────────────────────── the numbers ─────────────────────────────── */

async function stats() {
  const t = command.resolve({ range: 'today', compare: 'previous' });
  const w = command.resolve({ range: '7d', compare: 'previous' });
  const m = command.resolve({ range: 'this_month', compare: 'last_month' });
  const d30 = command.resolve({ range: '30d', compare: 'none' });
  const dv = (a, b) => `count(DISTINCT e.reg_no) FILTER (WHERE e.occurred_at >= '${a.toISOString()}' AND e.occurred_at < '${b.toISOString()}')::int`;
  const earliest = new Date(Math.min(m.prevFrom, w.prevFrom, d30.from));
  const [p, all] = await Promise.all([
    db.one(`SELECT ${dv(t.from, t.to)} AS today, ${dv(t.prevFrom, t.prevTo)} AS yesterday,
                   ${dv(w.from, w.to)} AS week, ${dv(w.prevFrom, w.prevTo)} AS prev_week,
                   ${dv(m.from, m.to)} AS month, ${dv(m.prevFrom, m.prevTo)} AS prev_month,
                   ${dv(d30.from, d30.to)} AS d30,
                   count(*) FILTER (WHERE e.occurred_at >= '${t.from.toISOString()}')::int AS lookups_today
              FROM events e WHERE e.name IN ${LOOKUP_NAMES} AND e.reg_no IS NOT NULL AND e.occurred_at >= $1`, [earliest]),
    db.one(`WITH per AS (
              SELECT v.id, v.reg_no,
                     (SELECT count(*) FROM events e WHERE e.reg_no = v.reg_no AND e.name IN ${LOOKUP_NAMES}) AS lookups,
                     EXISTS (SELECT 1 FROM events e WHERE e.reg_no = v.reg_no AND e.name IN ${LOOKUP_NAMES} AND e.channel = 'whatsapp') AS wa,
                     EXISTS (SELECT 1 FROM events e WHERE e.reg_no = v.reg_no AND e.name IN ${LOOKUP_NAMES} AND e.channel = 'web')
                       OR EXISTS (SELECT 1 FROM vehicle_reports r WHERE r.reg_no = v.reg_no AND r.channel = 'web') AS web,
                     EXISTS (SELECT 1 FROM payments p WHERE p.raw ? 'vehicle_id' AND p.raw->>'vehicle_id' = v.id::text AND p.status = 'paid') AS paid
                FROM vehicles v)
            SELECT count(*)::int AS total, count(*) FILTER (WHERE lookups >= 2)::int AS repeat,
                   count(*) FILTER (WHERE paid)::int AS paid, count(*) FILTER (WHERE NOT paid)::int AS unpaid,
                   count(*) FILTER (WHERE wa)::int AS whatsapp, count(*) FILTER (WHERE web)::int AS web
              FROM per`),
  ]);
  return {
    total: all.total, today: p.today, yesterday: p.yesterday, d7: p.week, d30: p.d30,
    compare: {
      day: { now: p.today, before: p.yesterday, label: 'Today vs yesterday (same hours)' },
      week: { now: p.week, before: p.prev_week, label: 'Last 7 days vs the 7 before' },
      month: { now: p.month, before: p.prev_month, label: 'This month vs the same days last month' },
    },
    repeat: all.repeat, paid: all.paid, unpaid: all.unpaid, whatsapp: all.whatsapp, web: all.web,
    lookups_today: p.lookups_today,
  };
}

/** The header's search box: up to five vehicles, answered as you type. */
async function quick(term) {
  const t = String(term || '').trim();
  if (t.length < 2) return { rows: [] };
  const out = await list({ q: t, limit: 5, archived: 'all' });
  return { rows: out.rows.map((r) => ({
    reg_no: r.reg_no, display: r.display, maker: r.maker, model: r.model, customer: r.customer,
    last_seen: r.last_seen, reports: r.reports, payment_status: r.payment_status, lookups: r.lookups,
  })), total: out.total };
}

/* ─────────────────────────────── one vehicle ─────────────────────────────── */

/* What each event is, in words, and which strand of the story it belongs to. */
const EVENT = {
  session_started: ['Website visit', 'website'], page_view: ['Page viewed', 'website'],
  whatsapp_cta_clicked: ['WhatsApp button clicked', 'website'],
  whatsapp_chat_started: ['WhatsApp conversation started', 'whatsapp'], whatsapp_greeting: ['Greeted on WhatsApp', 'whatsapp'],
  whatsapp_message_received: ['WhatsApp message received', 'whatsapp'], terms_accepted: ['Agreed to the terms', 'whatsapp'],
  whatsapp_vehicle_received: ['Vehicle number received', 'whatsapp'],
  vehicle_search_success: ['Vehicle found', 'lookup'], vehicle_search_failed: ['Vehicle not found', 'lookup'],
  vehicle_api_success: ['Records API answered', 'api'], vehicle_api_failed: ['Records API failed', 'api'],
  report_preview_viewed: ['Tapped the full report', 'report'], report_generated: ['Report generated', 'report'],
  report_delivered: ['Report delivered', 'report'],
  payment_started: ['Payment link sent', 'payment'], payment_page_viewed: ['Payment page opened', 'payment'],
  payment_success: ['Payment successful', 'payment'], payment_failed: ['Payment failed', 'payment'],
};
const labelOf = (e) => (EVENT[e.name] || [e.name.replace(/_/g, ' '), e.channel === 'web' ? 'website' : e.channel || 'system'])[0];
const strandOf = (e) => (EVENT[e.name] || [null, e.channel === 'web' ? 'website' : e.channel === 'whatsapp' ? 'whatsapp' : 'system'])[1];

/* Provider fields shown under "Basic details", in this order, with their names. */
const RC_FIELDS = [
  ['reg_no', 'Registration number'], ['maker', 'Manufacturer'], ['model', 'Model'], ['variant', 'Variant'],
  ['fuel', 'Fuel'], ['norms', 'Emission norms'], ['vehicle_class', 'Vehicle class'], ['vehicle_category', 'Vehicle category'],
  ['body_type', 'Body type'], ['colour', 'Colour'], ['manufactured', 'Manufactured (month/year)'],
  ['reg_date', 'Registration date'], ['reg_upto', 'Registration valid until'], ['registered_at', 'Registering authority'],
  ['rto_code', 'RTO code'], ['state_code', 'State'], ['status', 'RC status'], ['status_as_on', 'Status as on'],
  ['owner_serial', 'Owner count'], ['owner_type', 'Owner type'], ['owner_category', 'Owner category'],
  ['owner_name', 'Owner name'], ['address', 'Address'],
  ['chassis', 'Chassis (as returned, masked)'], ['engine', 'Engine (as returned, masked)'],
  ['financer', 'Financier'], ['seats', 'Seats'], ['cylinders', 'Cylinders'], ['cubic_capacity', 'Cubic capacity'],
  ['gross_weight', 'Gross weight'], ['unladen_weight', 'Unladen weight'], ['wheelbase', 'Wheelbase'],
  ['purchase_date', 'Purchase date'], ['sale_amount', 'Sale amount'],
];
const SENSITIVE_RC = ['owner_name', 'address'];

const daysFrom = (d) => {
  const day = ymd(d);
  if (!day) return null;
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  return Math.round((new Date(day) - new Date(today)) / 86400000);
};
const docStateOf = (upto, checked, soon) => {
  if (!checked && !upto) return 'unknown';
  if (!upto) return 'na';
  const d = daysFrom(upto);
  if (d == null || Number.isNaN(d)) return 'na';
  return d < 0 ? 'expired' : d < soon ? 'soon' : 'valid';
};

/* No credential ever leaves: anything that looks like one is replaced. */
const SECRET_KEY = /token|secret|password|passwd|authori[sz]ation|api[-_]?key|client[-_]?id|signature|cookie/i;
function redact(v, depth = 0) {
  if (depth > 10 || v == null) return v;
  if (typeof v === 'string') return v.replace(/(bearer\s+)[\w.-]+/gi, '$1[hidden]').replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[hidden]');
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[hidden]' : redact(x, depth + 1)]));
  }
  return v;
}

/** The vehicle row for a typed or pasted number — any spacing, any case. */
async function find(input) {
  const p = plate.normalize(input);
  if (!p) return null;
  if (/^\d+$/.test(String(input))) return db.one(`SELECT * FROM vehicles WHERE id = $1`, [Number(input)]);
  return db.one(`SELECT * FROM vehicles WHERE reg_no = $1`, [p]);
}

async function profile(input, { admin, canSensitive, canApi } = {}) {
  const v = await find(input);
  if (!v) return null;
  const reg = v.reg_no; const vid = String(v.id);
  const soon = await soonDays();

  const [snaps, pays, reports, calls, events, watchers, notes, tags, lists, adm, audit, heat] = await Promise.all([
    db.query(`SELECT dataset, data, source, fetched_at, expires_at FROM vehicle_snapshots WHERE vehicle_id = $1`, [v.id]),
    db.query(`SELECT p.*, u.mobile AS user_mobile FROM payments p LEFT JOIN users u ON u.id = p.user_id
               WHERE p.raw ? 'vehicle_id' AND p.raw->>'vehicle_id' = $1 ORDER BY p.created_at DESC`, [vid]),
    db.query(`SELECT r.id, r.report_number, r.created_at, r.valid_until, r.channel, r.user_id, r.payment_id,
                     r.requested_by, r.pdf_path IS NOT NULL AS has_file, u.mobile AS user_mobile
                FROM vehicle_reports r LEFT JOIN users u ON u.id = r.user_id
               WHERE r.reg_no = $1 ORDER BY r.created_at DESC`, [reg]),
    db.query(`SELECT id, created_at, dataset, provider_path, cache_hit, http_status, ok, outcome, error_code,
                     error_message, duration_ms, cost_paise, user_id
                FROM api_calls WHERE reg_no = $1 OR vehicle_id = $2 ORDER BY created_at DESC LIMIT 500`, [reg, v.id]),
    // The vehicle's own events, its payments' events, and — for the same
    // person within two hours of a lookup — the steps around it that name no
    // other vehicle or payment (the chat starting, the website visit).
    db.query(`WITH anchor AS (SELECT user_id, mobile, visitor_id, occurred_at FROM events WHERE reg_no = $1),
                   pays AS (SELECT id FROM payments WHERE raw ? 'vehicle_id' AND raw->>'vehicle_id' = $2)
              SELECT e.id, e.occurred_at, e.name, e.channel, e.visitor_id, e.session_id, e.user_id,
                     coalesce(e.mobile, u.mobile) AS person, e.reg_no, e.payment_id, e.source, e.campaign, e.page,
                     e.status, e.error_code, e.duration_ms, e.amount_paise, e.metadata
                FROM events e LEFT JOIN users u ON u.id = e.user_id
               WHERE e.reg_no = $1
                  OR e.payment_id IN (SELECT id FROM pays)
                  OR (e.reg_no IS NULL AND e.payment_id IS NULL AND EXISTS (
                        SELECT 1 FROM anchor a
                         WHERE ((a.user_id IS NOT NULL AND a.user_id = e.user_id)
                             OR (a.mobile IS NOT NULL AND a.mobile = e.mobile)
                             OR (a.visitor_id IS NOT NULL AND a.visitor_id = e.visitor_id))
                           AND e.occurred_at BETWEEN a.occurred_at - interval '2 hours' AND a.occurred_at + interval '2 hours'))
               ORDER BY e.occurred_at, e.id LIMIT 3000`, [reg, vid]),
    db.query(`SELECT uv.user_id, u.mobile, uv.relation, uv.check_count, uv.first_checked_at, uv.last_checked_at,
                     EXISTS (SELECT 1 FROM watches w WHERE w.user_id = uv.user_id AND w.vehicle_id = uv.vehicle_id AND w.is_active) AS watching,
                     (SELECT ws.id FROM whatsapp_sessions ws WHERE ws.user_id = uv.user_id ORDER BY ws.id DESC LIMIT 1) AS wa_session_id
                FROM user_vehicles uv JOIN users u ON u.id = uv.user_id WHERE uv.vehicle_id = $1`, [v.id]),
    db.query(`SELECT n.id, n.admin_id, n.body, n.created_at, n.edited_at, n.withdrawn_at, a.name AS admin,
                     w.name AS withdrawn_by, (SELECT count(*)::int FROM vehicle_note_versions x WHERE x.note_id = n.id) AS versions
                FROM vehicle_notes n LEFT JOIN admin_users a ON a.id = n.admin_id LEFT JOIN admin_users w ON w.id = n.withdrawn_by
               WHERE n.vehicle_id = $1 ORDER BY n.created_at DESC`, [v.id]),
    db.query(`SELECT t.tag, t.added_at, a.name AS added_by FROM vehicle_tags t LEFT JOIN admin_users a ON a.id = t.added_by
               WHERE t.vehicle_id = $1 ORDER BY t.tag`, [v.id]),
    db.query(`SELECT l.id, l.name FROM vehicle_list_items i JOIN vehicle_lists l ON l.id = i.list_id
               WHERE i.vehicle_id = $1 AND l.deleted_at IS NULL ORDER BY l.name`, [v.id]),
    db.one(`SELECT va.*, a.name AS assigned_name FROM vehicle_admin va LEFT JOIN admin_users a ON a.id = va.assigned_to
             WHERE va.vehicle_id = $1`, [v.id]),
    db.query(`SELECT x.id, x.action, x.detail, x.created_at, a.name AS admin
                FROM admin_audit x LEFT JOIN admin_users a ON a.id = x.admin_id
               WHERE x.detail->>'reg_no' = $1 OR x.detail->>'vehicle_id' = $2
               ORDER BY x.id DESC LIMIT 200`, [reg, vid]),
    db.query(`SELECT extract(isodow FROM e.occurred_at AT TIME ZONE 'Asia/Kolkata')::int AS dow,
                     extract(hour FROM e.occurred_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
                     to_char(e.occurred_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
                     to_char(date_trunc('week', e.occurred_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS week,
                     to_char(e.occurred_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month
                FROM events e WHERE e.reg_no = $1 AND e.name IN ${LOOKUP_NAMES}`, [reg]),
  ]);

  const snap = Object.fromEntries(snaps.rows.map((s) => [s.dataset, s]));
  const rc = snap.rc?.data || null;
  const checked = snap.rc?.fetched_at || null;
  const has = (x) => x != null && String(x).trim() !== '';

  /* Basic details — every field the provider returned, in words; nothing made up. */
  const known = new Set(RC_FIELDS.map(([k]) => k));
  const details = [
    ...RC_FIELDS.map(([k, label]) => {
      let value = rc && has(rc[k]) ? rc[k] : (k === 'reg_no' ? plate.pretty(reg) : null);
      const sensitive = SENSITIVE_RC.includes(k);
      if (sensitive && value != null && !canSensitive) value = k === 'owner_name' ? maskName(value) : 'Hidden';
      else if (sensitive && value != null) value = k === 'owner_name' ? maskName(value) : 'Hidden — reveal to see';
      return { key: k, label, value: typeof value === 'object' && value !== null ? JSON.stringify(value) : value, sensitive: sensitive && value != null };
    }),
    // Anything else the provider sent, so a new field shows without a release.
    ...Object.entries(rc || {}).filter(([k, x]) => !known.has(k) && !/upto$|^insurance_|^pucc_|^permit_|^tax_|^noc_|^blacklist/.test(k) && has(x))
      .map(([k, x]) => ({ key: k, label: k.replace(/_/g, ' '), value: typeof x === 'object' ? JSON.stringify(x) : x })),
  ];
  const age = (() => {
    const d = ymd(v.reg_date || rc?.reg_date);
    if (!d) return null;
    const y = (Date.now() - new Date(d)) / (365.25 * 86400000);
    return y >= 0 ? Math.floor(y * 10) / 10 : null;
  })();

  /* Documents. */
  const docCard = (key, label, upto, extra) => {
    const state = docStateOf(upto, checked, soon);
    return { key, label, state, upto: ymd(upto), days: daysFrom(upto), last_checked: checked, ...extra };
  };
  const documents = [
    docCard('insurance', 'Insurance', v.insurance_upto || rc?.insurance_upto, {
      provider: rc?.insurance_company || null, reference: rc?.insurance_policy || null, start: null }),
    docCard('puc', 'PUC', v.pucc_upto || rc?.pucc_upto, { reference: rc?.pucc_number || null, start: null }),
    docCard('tax', 'Road tax', v.tax_upto || rc?.tax_upto, { start: null }),
    docCard('permit', 'Permit', v.permit_upto || rc?.permit_upto, {
      permit_type: rc?.permit_type || null, reference: rc?.permit_number || null, start: null }),
    docCard('fitness', 'Fitness', v.fitness_upto || rc?.fitness_upto, { start: null }),
  ];

  /* Challans — the lists as the provider gave them. */
  const cd = snap.challan?.data || null;
  const challanRow = (c, state) => ({
    challan_no: c.challan_no || null, date: c.challan_date || c.challan_at || null, place: c.place || null,
    state_name: c.state || null, offence: c.offence || (c.offences || []).map((o) => o.name).join('; ') || null,
    offences: c.offences || [], amount_paise: c.amount_paise ?? null, paid_paise: c.paid_paise ?? null,
    status: c.status || state, court: c.court_name || null, court_status: c.court_status || null,
    sent_to_court: c.sent_to_court ?? null, department: c.department || null, rto_district: c.rto_district || null,
    receipt_no: c.receipt_no || null, remark: c.remark || null, proceeding_date: c.proceeding_date || null,
    group: state,
  });
  const challans = cd ? {
    checked_at: snap.challan.fetched_at, truncated: Boolean(cd.truncated), full_list_url: cd.full_list_url || null,
    total: (cd.pending_count || 0) + (cd.disposed_count || 0), pending: cd.pending_count || 0, paid: cd.disposed_count || 0,
    pending_amount_paise: cd.pending_amount_paise ?? null, paid_amount_paise: cd.disposed_amount_paise ?? null,
    newest: cd.summary?.newest_challan_date || null, oldest: cd.summary?.oldest_challan_date || null,
    in_court: cd.summary?.in_court ?? null,
    rows: [...(cd.pending || []).map((c) => challanRow(c, 'pending')), ...(cd.disposed || []).map((c) => challanRow(c, 'paid'))],
  } : null;

  const lastRc = calls.rows.find((c) => c.dataset === 'rc' || c.dataset === 'all');
  const blacklist = {
    known: Boolean(rc || v.blacklist_status),
    status: has(v.blacklist_status || rc?.blacklist_status) ? (v.blacklist_status || rc?.blacklist_status) : null,
    noc: rc && has(rc.noc_details) ? rc.noc_details : null, noc_date: rc?.noc_date || null,
    restriction: rc?.status && /ntbt|restrict|suspend|seiz|stolen|cancel/i.test(rc.status) ? rc.status : null,
    rc_status: v.rc_status || rc?.status || null,
    last_checked: checked, provider: snap.rc?.source || null,
    response: lastRc ? (lastRc.ok ? 'OK' : `Failed${lastRc.error_code ? ` (${lastRc.error_code})` : ''}`) : null,
  };
  const loan = {
    known: Boolean(rc), financier: has(v.financer || rc?.financer) ? (v.financer || rc?.financer) : null,
    hypothecation: has(v.financer || rc?.financer) ? 'Recorded on the RC' : null,
    start: null, end: null, last_checked: checked,
  };

  /* People: who looked this vehicle up — masked, with a handle to reveal. */
  const people = new Map();
  const personOf = (mobile, userId) => {
    const key = mobile || (userId ? `u${userId}` : null);
    if (!key) return null;
    if (!people.has(key)) {
      people.set(key, { ref: mobile ? refOf(vid, mobile) : `u${userId}`, customer: maskMobile(mobile), user_id: userId ? String(userId) : null,
        channels: new Set(), first: null, last: null, lookups: 0, reports: 0, paid: 0, paid_paise: 0, watching: false, wa_session_id: null });
    }
    const p = people.get(key);
    if (userId && !p.user_id) p.user_id = String(userId);
    return p;
  };
  const touch = (p, at) => { if (!p || !at) return; if (!p.first || at < p.first) p.first = at; if (!p.last || at > p.last) p.last = at; };
  for (const e of events.rows) {
    if (e.reg_no !== reg || !['vehicle_search_success', 'vehicle_search_failed'].includes(e.name)) continue;
    const p = personOf(e.person, e.user_id);
    if (!p) continue;
    p.lookups += 1; if (e.channel) p.channels.add(e.channel); touch(p, e.occurred_at);
  }
  for (const w of watchers.rows) {
    const p = personOf(w.mobile, w.user_id);
    touch(p, w.first_checked_at); touch(p, w.last_checked_at);
    p.watching = p.watching || w.watching; p.wa_session_id = w.wa_session_id ? String(w.wa_session_id) : p.wa_session_id;
    if (!p.lookups && w.check_count) p.lookups = w.check_count;
  }
  for (const r of reports.rows) { const p = personOf(r.user_mobile || r.requested_by, r.user_id); if (p) { p.reports += 1; p.channels.add(r.channel); touch(p, r.created_at); } }
  for (const x of pays.rows) {
    if (x.status !== 'paid') continue;
    const p = personOf(x.user_mobile, x.user_id); if (p) { p.paid += 1; p.paid_paise += x.amount_paise || 0; }
  }
  const customers = [...people.values()].map((p) => ({ ...p, channels: [...p.channels].filter(Boolean) }))
    .sort((a, b) => new Date(b.last || 0) - new Date(a.last || 0));

  /* Timeline — every event, in words, masked. */
  const timeline = events.rows.map((e) => ({
    id: String(e.id), at: e.occurred_at, name: e.name, label: labelOf(e), strand: strandOf(e), channel: e.channel,
    customer: maskMobile(e.person), visitor: e.visitor_id ? `${e.visitor_id.slice(0, 6)}…` : null,
    source: e.source, campaign: e.campaign, page: e.page, status: e.status, error_code: e.error_code,
    duration_ms: e.duration_ms, amount_paise: e.amount_paise, payment_id: e.payment_id ? String(e.payment_id) : null,
    report_number: e.metadata?.report_number || null, other_vehicle: false,
  }));
  // Reports and payments from their own tables too — older ones predate events.
  const seen = new Set(timeline.map((t) => `${t.name}:${t.report_number || t.payment_id || ''}`));
  for (const r of reports.rows) {
    if (!seen.has(`report_generated:${r.report_number}`)) {
      timeline.push({ id: `r${r.id}`, at: r.created_at, name: 'report_generated', label: 'Report generated', strand: 'report',
        channel: r.channel, customer: maskMobile(r.user_mobile || r.requested_by), report_number: r.report_number });
    }
  }
  for (const x of pays.rows) {
    if (x.status === 'paid' && !seen.has(`payment_success:${x.id}`)) {
      timeline.push({ id: `p${x.id}`, at: x.paid_at || x.created_at, name: 'payment_success', label: 'Payment successful',
        strand: 'payment', customer: maskMobile(x.user_mobile), amount_paise: x.amount_paise, payment_id: String(x.id) });
    }
  }
  timeline.sort((a, b) => new Date(a.at) - new Date(b.at));

  /* WhatsApp history: each person's steps, split where they were away three hours or more. */
  const waSessions = [];
  const byPerson = new Map();
  for (const t of timeline) {
    if (t.strand === 'website' || !t.customer) continue;
    const list = byPerson.get(t.customer) || []; list.push(t); byPerson.set(t.customer, list);
  }
  for (const [customer, steps] of byPerson) {
    if (!steps.some((s) => s.channel === 'whatsapp')) continue;
    let cur = null;
    for (const s of steps) {
      if (!cur || new Date(s.at) - new Date(cur.steps[cur.steps.length - 1].at) > 3 * 3600000) {
        cur = { customer, started_at: s.at, steps: [] }; waSessions.push(cur);
      }
      cur.steps.push(s);
    }
  }
  for (const s of waSessions) {
    const who = customers.find((c) => c.customer === s.customer);
    s.session_id = who?.wa_session_id || null; s.ref = who?.ref || null; s.user_id = who?.user_id || null;
    const names = new Set(s.steps.map((x) => x.name));
    s.milestones = {
      started: names.has('whatsapp_chat_started') || names.has('whatsapp_greeting') || names.has('whatsapp_message_received'),
      vehicle_received: names.has('whatsapp_vehicle_received'), found: names.has('vehicle_search_success'),
      preview: names.has('report_preview_viewed'), payment_link: names.has('payment_started'),
      paid: names.has('payment_success'), report: names.has('report_generated'), delivered: names.has('report_delivered'),
    };
  }

  /* Website history: the visitors who reached this vehicle, and how they arrived. */
  const visitorIds = [...new Set(events.rows.filter((e) => e.visitor_id).map((e) => e.visitor_id))];
  const { rows: visitors } = visitorIds.length ? await db.query(
    `SELECT visitor_id, first_seen_at, last_seen_at, first_touch, last_touch, page_views, wa_clicks, linked_at
       FROM visitors WHERE visitor_id = ANY($1::text[])`, [visitorIds]) : { rows: [] };
  const web = {
    visitors: visitors.map((x) => ({
      visitor: `${x.visitor_id.slice(0, 6)}…`, first_seen: x.first_seen_at, last_seen: x.last_seen_at,
      landing_page: x.first_touch?.landing_page || x.first_touch?.page || null,
      utm_source: x.first_touch?.utm_source || x.first_touch?.source || null,
      utm_campaign: x.first_touch?.utm_campaign || x.first_touch?.campaign || null,
      referrer: x.first_touch?.referrer || null, page_views: x.page_views, wa_clicks: x.wa_clicks, linked_to_whatsapp: Boolean(x.linked_at),
    })),
    steps: timeline.filter((t) => t.strand === 'website' || t.channel === 'web'),
    reports_on_web: reports.rows.filter((r) => r.channel === 'web').length,
  };

  /* Payments, with what GST and the gateway took out of each. */
  const delivered = new Set(events.rows.filter((e) => e.name === 'report_delivered').map((e) => String(e.payment_id || e.metadata?.report_number)));
  const payments = [];
  const money = Object.fromEntries((await ledger.entries({ ids: pays.rows.map((x) => x.id), all: true })).rows.map((e) => [e.id, e]));
  for (const x of pays.rows) {
    const e = money[String(x.id)] || {};
    const settled = ['paid', 'refunded'].includes(x.status);
    const s = { gst_paise: e.gst_paise, gateway_fee_paise: e.gateway_fee_paise || 0, gateway_fee_gst_paise: e.gateway_gst_paise || 0 };
    payments.push({
      id: String(x.id), payment_id: x.payment_id, order_id: x.order_id, gateway: x.gateway || x.raw?.gateway || null,
      customer: maskMobile(x.user_mobile), user_id: x.user_id ? String(x.user_id) : null,
      amount_paise: x.amount_paise, gst_paise: settled ? s.gst_paise : null,
      gateway_fee_paise: settled ? s.gateway_fee_paise + s.gateway_fee_gst_paise : null, fee_source: e.fee_source || null,
      net_paise: settled ? e.net_paise : null,
      status: x.status, method: e.method || x.raw?.method || null, created_at: x.created_at, paid_at: x.paid_at,
      refunded_at: x.refunded_at, refund_id: x.refund_id, buyer_state: x.raw?.buyer_state_code || null,
      report: reports.rows.find((r) => String(r.payment_id) === String(x.id))?.report_number || null,
    });
  }

  const reportRows = reports.rows.map((r) => {
    const pay = pays.rows.find((x) => String(x.id) === String(r.payment_id));
    return {
      id: String(r.id), report_number: r.report_number, created_at: r.created_at, channel: r.channel,
      customer: maskMobile(r.user_mobile || r.requested_by), type: r.payment_id ? 'Paid full report' : 'Free / credit',
      payment_status: pay ? pay.status : r.payment_id ? 'unknown' : 'not needed',
      delivered: delivered.has(String(r.payment_id)) || delivered.has(r.report_number) ? 'Delivered' : (r.channel === 'whatsapp' ? 'Not recorded' : 'Downloaded on the website'),
      status: r.valid_until && new Date(r.valid_until) < new Date() ? 'Expired' : 'Available', has_file: r.has_file,
      valid_until: r.valid_until,
    };
  });

  /* API history — admin-only, and never a credential in it. */
  const api = canApi ? calls.rows.map((c) => ({
    id: String(c.id), at: c.created_at, provider: c.provider_path ? c.provider_path.split('/')[0] : null,
    operation: c.provider_path || c.dataset, dataset: c.dataset, cache_hit: c.cache_hit, ok: c.ok,
    outcome: c.outcome, http_status: c.http_status, duration_ms: c.duration_ms, cost_paise: c.cost_paise,
    error_code: c.error_code, error: c.error_message ? redact(c.error_message) : null, retries: null,
  })) : null;

  /* How fresh the stored data is, and what a refresh would cost. */
  const live = calls.rows.filter((c) => !c.cache_hit);
  const lastOk = live.find((c) => c.ok);
  const unitCost = async (ds) => {
    const { avg } = await db.one(`SELECT round(avg(cost_paise))::int AS avg FROM (SELECT cost_paise FROM api_calls
                                   WHERE dataset = $1 AND NOT cache_hit ORDER BY id DESC LIMIT 20) s`, [ds]);
    return avg;
  };
  const costs = await Promise.all(['rc', 'challan', 'fastag'].map(unitCost));
  const freshness = {
    datasets: ['rc', 'challan', 'fastag'].map((ds) => ({
      dataset: ds, fetched_at: snap[ds]?.fetched_at || null, expires_at: snap[ds]?.expires_at || null,
      cached: Boolean(snap[ds]), source: snap[ds]?.source || null,
    })),
    last_lookup: live[0]?.created_at || null, last_success: lastOk?.created_at || null,
    refresh_cost_paise: costs.every((c) => c == null) ? null : costs.reduce((a, c) => a + (c || 0), 0),
    recent_refresh_minutes: live[0] ? Math.floor((Date.now() - new Date(live[0].created_at)) / 60000) : null,
  };

  /* When it is looked up: hour × weekday, and by day / week / month. */
  const count = (key) => Object.entries(heat.rows.reduce((a, r) => ({ ...a, [r[key]]: (a[r[key]] || 0) + 1 }), {}))
    .map(([k, n]) => ({ key: k, n })).sort((a, b) => a.key.localeCompare(b.key));
  const grid = {}; for (const r of heat.rows) grid[`${r.dow}:${r.hour}`] = (grid[`${r.dow}:${r.hour}`] || 0) + 1;

  const docsOut = documents;
  const expired = docsOut.filter((d) => d.state === 'expired').map((d) => d.label);
  const overall = {
    rc_status: blacklist.rc_status,
    expired, expiring: docsOut.filter((d) => d.state === 'soon').map((d) => d.label),
    challans_pending: challans ? challans.pending : null,
    blacklisted: blacklist.known ? Boolean(blacklist.status) : null,
    financier: loan.known ? Boolean(loan.financier) : null,
  };

  return {
    vehicle: {
      id: vid, reg_no: reg, display: plate.pretty(reg), maker: v.maker || rc?.maker || null, model: v.model || rc?.model || null,
      variant: null, fuel: v.fuel || rc?.fuel || null, vehicle_class: v.vehicle_class || rc?.vehicle_class || null,
      category: rc?.vehicle_category || null, age_years: age, state: reg.slice(0, 2),
      rto: /^[A-Z]{2}\d{2}/.test(reg) ? reg.slice(0, 4) : reg.slice(0, 2), registered_at: rc?.registered_at || null,
      first_seen: v.first_seen_at, last_seen: v.last_seen_at, last_updated: checked,
    },
    overall, details, documents: docsOut, soon_days: soon, challans, blacklist, loan,
    fastag: snap.fastag ? { ...snap.fastag.data, checked_at: snap.fastag.fetched_at } : null,
    customers, whatsapp: waSessions.reverse(), web, payments, reports: reportRows, api, timeline,
    heat: { grid, by_day: count('day'), by_week: count('week'), by_month: count('month'), total: heat.rows.length },
    freshness,
    notes: notes.rows.map((n) => ({ ...n, id: String(n.id), admin_id: n.admin_id ? String(n.admin_id) : null })),
    tags: tags.rows, lists: lists.rows.map((l) => ({ ...l, id: String(l.id) })),
    admin: adm ? { assigned_to: adm.assigned_to ? String(adm.assigned_to) : null, assigned_name: adm.assigned_name,
                   archived_at: adm.archived_at } : { assigned_to: null, archived_at: null },
    audit: audit.rows.map((a) => ({ id: String(a.id), action: a.action, admin: a.admin, at: a.created_at,
                                    detail: redact(maskAudit(a.detail)) })),
    counts: {
      lookups: heat.rows.length, customers: customers.length, reports: reportRows.length,
      paid: payments.filter((p) => p.status === 'paid').length,
      paid_paise: payments.filter((p) => p.status === 'paid').reduce((a, p) => a + p.amount_paise, 0),
      api_calls: calls.rows.length, api_failed: calls.rows.filter((c) => !c.ok).length,
    },
    viewer: { admin_id: admin?.id ? String(admin.id) : null },
  };
}

/* An audit entry's own mobiles are masked too. */
function maskAudit(d) {
  if (!d || typeof d !== 'object') return d;
  return Object.fromEntries(Object.entries(d).map(([k, x]) => [k, /mobile|phone/i.test(k) && typeof x === 'string' ? maskMobile(x) : x]));
}

/**
 * The full number behind a masked customer, or the RC owner's name and
 * address. Callers audit; this only finds.
 */
async function reveal(input, { ref, what }) {
  const v = await find(input);
  if (!v) return null;
  if (what === 'owner') {
    const s = await db.one(`SELECT data->>'owner_name' AS owner_name, data->>'address' AS address
                              FROM vehicle_snapshots WHERE vehicle_id = $1 AND dataset = 'rc'`, [v.id]);
    return { vehicle: v, owner_name: s?.owner_name || null, address: s?.address || null };
  }
  const r = String(ref || '');
  if (/^u\d+$/.test(r)) {
    const u = await db.one(`SELECT id, mobile FROM users WHERE id = $1`, [Number(r.slice(1))]);
    // Only a customer connected with this vehicle.
    const linked = u && await db.one(
      `SELECT 1 AS ok WHERE EXISTS (SELECT 1 FROM user_vehicles WHERE user_id = $1 AND vehicle_id = $2)
          OR EXISTS (SELECT 1 FROM events WHERE user_id = $1 AND reg_no = $3)
          OR EXISTS (SELECT 1 FROM vehicle_reports WHERE user_id = $1 AND reg_no = $3)`, [u.id, v.id, v.reg_no]);
    return linked ? { vehicle: v, mobile: u.mobile, user_id: String(u.id) } : { vehicle: v, mobile: null };
  }
  const { rows } = await db.query(
    `SELECT DISTINCT coalesce(e.mobile, u.mobile) AS m FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.reg_no = $1
     UNION SELECT u.mobile FROM user_vehicles uv JOIN users u ON u.id = uv.user_id WHERE uv.vehicle_id = $2
     UNION SELECT coalesce(u.mobile, r.requested_by) FROM vehicle_reports r LEFT JOIN users u ON u.id = r.user_id WHERE r.reg_no = $1
     UNION SELECT u.mobile FROM payments p JOIN users u ON u.id = p.user_id WHERE p.raw ? 'vehicle_id' AND p.raw->>'vehicle_id' = $3`,
    [v.reg_no, v.id, String(v.id)]);
  const hit = rows.find((x) => x.m && refOf(String(v.id), x.m) === r);
  const u = hit && await db.one(`SELECT id FROM users WHERE mobile = $1`, [hit.m]);
  return { vehicle: v, mobile: hit ? hit.m : null, user_id: u ? String(u.id) : null };
}

/** The provider's stored answer for one dataset — admin-only, secrets removed. */
async function rawResponse(input, dataset, { canSensitive }) {
  const v = await find(input);
  if (!v || !['rc', 'challan', 'fastag'].includes(dataset)) return null;
  const s = await db.one(`SELECT raw, data, source, fetched_at, expires_at FROM vehicle_snapshots WHERE vehicle_id = $1 AND dataset = $2`, [v.id, dataset]);
  if (!s) return { vehicle: v, found: false };
  let body = redact(s.raw || s.data);
  if (!canSensitive && body && typeof body === 'object') {
    body = { ...body };
    for (const k of SENSITIVE_RC) if (body[k]) body[k] = k === 'owner_name' ? maskName(body[k]) : 'Hidden';
    if (Array.isArray(body.pending)) body.pending = body.pending.map((c) => ({ ...c, violator_name: maskName(c.violator_name), dl_no: c.dl_no ? 'Hidden' : c.dl_no }));
    if (Array.isArray(body.disposed)) body.disposed = body.disposed.map((c) => ({ ...c, violator_name: maskName(c.violator_name), dl_no: c.dl_no ? 'Hidden' : c.dl_no }));
  }
  return { vehicle: v, found: true, source: s.source, fetched_at: s.fetched_at, expires_at: s.expires_at, body };
}

/* ─────────────────────────────── export ─────────────────────────────── */

const EXPORT_FIELDS = {
  reg_no: ['Vehicle number', (r) => r.reg_no], maker: ['Manufacturer', (r) => r.maker], model: ['Model', (r) => r.model],
  fuel: ['Fuel', (r) => r.fuel], vehicle_class: ['Vehicle class', (r) => r.vehicle_class], state: ['State', (r) => r.state],
  rto: ['RTO', (r) => r.rto], first_seen: ['First seen', (r) => r.first_seen], last_seen: ['Last seen', (r) => r.last_seen],
  lookups: ['Lookups', (r) => r.lookups], reports: ['Reports generated', (r) => r.reports], paid: ['Reports purchased', (r) => r.paid],
  revenue: ['Revenue (₹)', (r) => (r.paid_paise / 100).toFixed(2)], last_channel: ['Last channel', (r) => r.last_channel],
  payment_status: ['Payment status', (r) => r.payment_status],
  insurance: ['Insurance', (r) => r.docs.insurance.state], insurance_upto: ['Insurance until', (r) => r.docs.insurance.upto],
  puc: ['PUC', (r) => r.docs.puc.state], puc_upto: ['PUC until', (r) => r.docs.puc.upto],
  tax: ['Road tax', (r) => r.docs.tax.state], tax_upto: ['Tax until', (r) => r.docs.tax.upto],
  permit: ['Permit', (r) => r.docs.permit.state], permit_upto: ['Permit until', (r) => r.docs.permit.upto],
  expired_docs: ['Expired documents', (r) => r.expired_docs],
  challans_pending: ['Pending challans', (r) => r.challans_pending], challans_total: ['Total challans', (r) => r.challans_total],
  blacklisted: ['Blacklisted', (r) => (r.blacklisted == null ? 'Unknown' : r.blacklisted ? 'Yes' : 'No')],
  financier: ['Financier on RC', (r) => (r.financier == null ? 'Unknown' : r.financier ? 'Yes' : 'None recorded')],
  customer: ['Last customer (masked)', (r) => r.customer], customers: ['Customers', (r) => r.customers],
  tags: ['Tags', (r) => (r.tags || []).join(' ')], assigned: ['Assigned to', (r) => r.assigned_name],
};
const csvCell = (x) => {
  if (x == null) return '';
  const s = x instanceof Date ? new Date(x.getTime() + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ') : String(x);
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

async function exportCsv(q, admin) {
  const fields = String(q.fields || '').split(',').filter((f) => EXPORT_FIELDS[f]);
  const use = fields.length ? fields : Object.keys(EXPORT_FIELDS);
  const ids = String(q.ids || '').split(',').filter((x) => /^\d+$/.test(x));
  const rows = [];
  for (let offset = 0; offset < 20000; offset += 200) {
    const page = await list({ ...q, limit: 200, offset }, admin);
    rows.push(...page.rows);
    if (page.rows.length < 200) break;
  }
  const picked = ids.length ? rows.filter((r) => ids.includes(r.id)) : rows;
  const csv = [use.map((f) => csvCell(EXPORT_FIELDS[f][0])).join(','),
    ...picked.map((r) => use.map((f) => csvCell(EXPORT_FIELDS[f][1](r))).join(','))].join('\r\n');
  return { csv, rows: picked.length, fields: use };
}

module.exports = {
  list, stats, quick, profile, reveal, rawResponse, exportCsv, find, maskMobile,
  VIEWS, EXPORT_FIELDS: Object.fromEntries(Object.entries(EXPORT_FIELDS).map(([k, [l]]) => [k, l])),
};
