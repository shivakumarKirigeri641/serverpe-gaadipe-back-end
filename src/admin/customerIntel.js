/**
 * src/admin/customerIntel.js — Customer Intelligence and retention (user,
 * 2026-09-25, operations module phase 3).
 * ---------------------------------------------------------------------------
 *   list(q)       every customer with their lifetime: first seen, last
 *                 active, sessions, vehicles searched (and how many
 *                 different), reports, purchases, revenue, first source,
 *                 payment failures, last vehicle, last channel. Server-side
 *                 search, sort and pages. One row opens their journey.
 *   retention(q)  new and returning customers, repeat searches and
 *                 purchases, return after 1 / 7 / 30 days, reports and
 *                 revenue per customer — and weekly cohorts
 *
 * A customer is a users row (every WhatsApp contact is one — migration 065).
 * Their activity is their events, by user id or mobile. Cohorts are real
 * counts; a cohort too small to mean much is marked so, never padded.
 * Referral figures are not shown: GaadiPe has no referral programme for now.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const command = require('./command');

const LOOKUP = `('vehicle_search_success', 'vehicle_search_failed')`;

/* Per customer: everything the list shows, in one pass. */
const BASE = `
  SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.created_at, u.signup_channel,
         ws.wa_opt_out_at, ws.last_inbound_at, ws.attribution,
         ev.first_at, ev.last_at, ev.lookups, ev.vehicles, ev.days_active, ev.last_channel, ev.last_reg,
         vis.first_touch, coalesce(vis.visitors, 0) AS visitors,
         coalesce(ss.sessions, 0) AS site_sessions,
         coalesce(rp.reports, 0) AS reports,
         coalesce(py.paid, 0) AS paid, coalesce(py.revenue, 0) AS revenue_paise, coalesce(py.failed, 0) AS pay_failures,
         greatest(ev.last_at, ws.last_inbound_at, py.last_paid) AS last_active
    FROM users u
    LEFT JOIN LATERAL (SELECT s.wa_opt_out_at, s.last_inbound_at, s.attribution FROM whatsapp_sessions s
                        WHERE s.user_id = u.id OR s.mobile = u.mobile ORDER BY s.id DESC LIMIT 1) ws ON true
    LEFT JOIN LATERAL (
      SELECT min(e.occurred_at) AS first_at, max(e.occurred_at) AS last_at,
             count(*) FILTER (WHERE e.name IN ${LOOKUP})::int AS lookups,
             count(DISTINCT e.reg_no) FILTER (WHERE e.name IN ${LOOKUP})::int AS vehicles,
             count(DISTINCT (e.occurred_at AT TIME ZONE 'Asia/Kolkata')::date)::int AS days_active,
             (array_agg(e.channel ORDER BY e.occurred_at DESC) FILTER (WHERE e.channel IN ('web', 'whatsapp')))[1] AS last_channel,
             (array_agg(e.reg_no ORDER BY e.occurred_at DESC) FILTER (WHERE e.reg_no IS NOT NULL))[1] AS last_reg
        FROM events e WHERE e.user_id = u.id OR (u.mobile IS NOT NULL AND e.mobile = u.mobile)) ev ON true
    LEFT JOIN LATERAL (SELECT (array_agg(v.first_touch ORDER BY v.first_seen_at))[1] AS first_touch, count(*)::int AS visitors
                         FROM visitors v WHERE v.user_id = u.id OR v.mobile = u.mobile) vis ON true
    LEFT JOIN LATERAL (SELECT count(*)::int AS sessions FROM site_sessions x WHERE x.user_id = u.id) ss ON true
    LEFT JOIN LATERAL (SELECT count(*)::int AS reports FROM vehicle_reports r WHERE r.user_id = u.id) rp ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE p.status IN ('paid', 'refunded') AND p.amount_paise > 0)::int AS paid,
             coalesce(sum(p.amount_paise) FILTER (WHERE p.status = 'paid'), 0)::bigint AS revenue,
             max(p.paid_at) AS last_paid,
             (SELECT count(*)::int FROM event_log l WHERE l.kind = 'razorpay_webhook' AND l.detail->>'event' = 'payment.failed'
                 AND split_part(l.detail->>'reference_id', '-', 2) IN (SELECT p2.id::text FROM payments p2 WHERE p2.user_id = u.id)) AS failed
        FROM payments p WHERE p.user_id = u.id) py ON true`;

const SORTS = { last_active: 'last_active', first_seen: 'first_seen', revenue: 'revenue_paise', reports: 'reports', paid: 'paid',
  vehicles: 'vehicles', lookups: 'lookups', failures: 'pay_failures' };

const sourceOf = (x) => x.attribution?.first_touch?.source || x.first_touch?.source
  || (x.attribution?.channel === 'whatsapp_ad' ? 'meta_ads' : x.signup_channel === 'web' ? 'website_signup' : 'whatsapp_direct');

async function list(q = {}) {
  const args = []; const w = [];
  const bind = (v) => { args.push(v); return `$${args.length}`; };
  const term = String(q.q || '').trim();
  if (term) {
    const digits = term.replace(/\D/g, '');
    const reg = term.toUpperCase().replace(/[^A-Z0-9]/g, '');
    w.push(`(${digits.length >= 4 ? `x.mobile LIKE ${bind(`%${digits}`)} OR ` : ''}x.name ILIKE ${bind(`%${term}%`)}
             OR x.id IN (SELECT e.user_id FROM events e WHERE e.reg_no = ${bind(reg)}))`);
  }
  if (q.paid === 'yes') w.push('x.paid > 0');
  if (q.paid === 'no') w.push('x.paid = 0');
  if (q.repeat === '1') w.push('x.paid >= 2');
  if (q.failures === '1') w.push('x.pay_failures > 0');
  if (q.opted_out === '1') w.push('x.wa_opt_out_at IS NOT NULL');
  const r = q.range ? command.resolve({ range: q.range, from: q.from, to: q.to, compare: 'none' }) : null;
  if (r) w.push(`x.last_active >= ${bind(r.from)} AND x.last_active < ${bind(r.to)}`);
  const sort = SORTS[q.sort] || 'last_active';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(200, Number(q.limit) || 50); const offset = Math.max(0, Number(q.offset) || 0);
  const { rows } = await db.query(
    `SELECT x.*, least(x.created_at, x.first_at) AS first_seen, count(*) OVER () AS total_rows FROM (${BASE}) x
      ${w.length ? `WHERE ${w.join(' AND ')}` : ''}
      ORDER BY ${sort === 'first_seen' ? 'least(x.created_at, x.first_at)' : `x.${sort}`} ${dir} NULLS LAST, x.id DESC
      LIMIT ${limit} OFFSET ${offset}`, args);
  return {
    total: rows[0] ? Number(rows[0].total_rows) : 0,
    rows: rows.map((x) => ({
      id: String(x.id), mobile: x.mobile, name: x.name,
      whatsapp: x.wa_opt_out_at ? 'opted_out' : x.last_inbound_at && Date.now() - new Date(x.last_inbound_at) < 24 * 3600e3 ? 'in_window' : x.last_inbound_at ? 'known' : 'never',
      first_seen: x.first_seen, last_active: x.last_active,
      sessions: x.site_sessions + (x.days_active || 0), days_active: x.days_active || 0,
      lookups: x.lookups || 0, vehicles: x.vehicles || 0, reports: x.reports, paid: x.paid, revenue_paise: Number(x.revenue_paise),
      pay_failures: x.pay_failures, source: sourceOf(x), last_reg: x.last_reg, last_channel: x.last_channel === 'web' ? 'website' : x.last_channel,
    })),
    notes: { sessions: 'Sessions: website sign-in sessions plus days with WhatsApp or website activity.', referral: 'Referral figures are not shown — no referral programme for now.' },
  };
}

/* ─────────────────────────────── retention ─────────────────────────────── */

async function retention(q = {}) {
  const r = command.resolve({ range: q.range || '30d', from: q.from, to: q.to, compare: 'none' });
  // Each customer's active IST days, and paid purchases.
  const { rows } = await db.query(
    `WITH act AS (
       SELECT u.id, (e.occurred_at AT TIME ZONE 'Asia/Kolkata')::date AS d, e.name
         FROM users u JOIN events e ON (e.user_id = u.id OR (u.mobile IS NOT NULL AND e.mobile = u.mobile))
        WHERE e.name NOT IN ('vehicle_api_success', 'vehicle_api_failed')
     )
     SELECT u.id, least(u.created_at, (SELECT min(e.occurred_at) FROM events e WHERE e.user_id = u.id OR e.mobile = u.mobile)) AS first_seen,
            (SELECT array_agg(DISTINCT d ORDER BY d) FROM act WHERE act.id = u.id) AS days,
            (SELECT count(*) FROM act WHERE act.id = u.id AND act.name IN ${LOOKUP}
                AND act.d >= ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date AND act.d < ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date + 1)::int AS lookups_in,
            (SELECT count(*) FROM payments p WHERE p.user_id = u.id AND p.status IN ('paid', 'refunded') AND p.amount_paise > 0)::int AS purchases,
            (SELECT min(p.paid_at) FROM payments p WHERE p.user_id = u.id AND p.status IN ('paid', 'refunded') AND p.amount_paise > 0) AS first_paid,
            (SELECT coalesce(sum(p.amount_paise), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid')::bigint AS revenue,
            (SELECT count(*) FROM payments p WHERE p.user_id = u.id AND p.status IN ('paid', 'refunded') AND p.amount_paise > 0
                AND p.paid_at >= $1 AND p.paid_at < $2)::int AS purchases_in,
            (SELECT count(*) FROM vehicle_reports x WHERE x.user_id = u.id)::int AS reports
       FROM users u`, [r.from, r.to]);
  const day = (d) => new Date(d).getTime();
  const fromD = new Date(new Date(r.from).getTime() + 330 * 60000).toISOString().slice(0, 10);
  const toD = new Date(new Date(r.to).getTime() + 330 * 60000 - 1).toISOString().slice(0, 10);
  const people = rows.filter((x) => x.first_seen);
  const active = people.filter((x) => (x.days || []).some((d) => { const s = new Date(d).toISOString().slice(0, 10); return s >= fromD && s <= toD; }));
  const isNew = (x) => new Date(x.first_seen) >= new Date(r.from);
  const newC = active.filter(isNew); const returning = active.filter((x) => !isNew(x));
  const cameBack = (x, n) => {
    const ds = (x.days || []).map(day); if (!ds.length) return false;
    const first = Math.min(...ds); return ds.some((d) => d - first >= n * 86400000);
  };
  const payers = active.filter((x) => x.purchases > 0);
  const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

  // Weekly cohorts by first activity (Monday, IST), the last 12 weeks.
  const weekOf = (t) => { const d = new Date(new Date(t).getTime() + 330 * 60000); const dow = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - dow * 86400000).toISOString().slice(0, 10); };
  const cutoff = Date.now() - 12 * 7 * 86400000;
  const cohorts = {};
  for (const x of people) {
    if (new Date(x.first_seen).getTime() < cutoff) continue;
    const k = weekOf(x.first_seen);
    const c = (cohorts[k] = cohorts[k] || { week: k, customers: 0, first_purchase: 0, repeat_purchase: 0, returned_7d: 0, revenue_paise: 0 });
    c.customers += 1; if (x.purchases > 0) c.first_purchase += 1; if (x.purchases > 1) c.repeat_purchase += 1;
    if (cameBack(x, 7)) c.returned_7d += 1; c.revenue_paise += Number(x.revenue);
  }
  const MIN = 5;
  return {
    range: { label: r.label },
    active: active.length, new_customers: newC.length, returning_customers: returning.length,
    repeat_searchers: active.filter((x) => x.lookups_in >= 2).length,
    repeat_purchasers: payers.filter((x) => x.purchases >= 2).length,
    returned_after: { d1: active.filter((x) => cameBack(x, 1)).length, d7: active.filter((x) => cameBack(x, 7)).length, d30: active.filter((x) => cameBack(x, 30)).length },
    repeat_customer_rate: rate(returning.length, active.length),
    repeat_purchase_rate: rate(payers.filter((x) => x.purchases >= 2).length, payers.length),
    avg_reports_per_customer: active.length ? Math.round((active.reduce((s, x) => s + x.reports, 0) / active.length) * 100) / 100 : null,
    avg_revenue_per_customer_paise: payers.length ? Math.round(payers.reduce((s, x) => s + Number(x.revenue), 0) / payers.length) : null,
    cohorts: Object.values(cohorts).sort((a, b) => b.week.localeCompare(a.week)).map((c) => ({ ...c, small: c.customers < MIN })),
    cohort_min: MIN,
    notes: {
      returned: 'Returned after N days: active again at least N days after their first active day.',
      small: `A cohort of fewer than ${MIN} customers is shown as it is, and marked — too small to read a rate from.`,
    },
  };
}

module.exports = { list, retention, sourceOf };
