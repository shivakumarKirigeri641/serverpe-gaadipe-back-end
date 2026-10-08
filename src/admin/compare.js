/**
 * src/admin/compare.js — UP OR DOWN, AND BY HOW MUCH (user, 2026-10-08: "put
 * inc/dec % changes on every value in the admin panel — vs yesterday, vs last
 * week and more").
 *
 * One answer for the whole panel: each key number, counted over seven windows
 * (Indian time), so any tile can show its change without a query of its own.
 *
 *   today        midnight → now
 *   yesterday    yesterday's midnight → the same time yesterday   (a fair "so far")
 *   last_week    the same weekday last week, midnight → the same time
 *   d7 / prev7   the last 7 × 24 h, and the 7 × 24 h before them
 *   mtd / prev_mtd  this month so far, and the same days of last month
 *
 * Website numbers, except new_vehicles (every channel — vehicles matter whatever
 * the channel, 2026-10-08). Kept for 60 s: tiles ask often, numbers move slowly.
 */

const db = require('../db');

const WEB_PAID = `status = 'paid' AND amount_paise > 0 AND coalesce(raw->>'channel', raw->'paid_from'->>'channel', 'whatsapp') = 'web'`;

/* key: [table, time column, filter, aggregate, words] */
const METRICS = {
  visits:          ['events', 'occurred_at', `name = 'session_started' AND channel = 'web'`, 'count(*)', 'Visits'],
  visitors:        ['events', 'occurred_at', `name = 'session_started' AND channel = 'web'`, 'count(DISTINCT visitor_id)', 'Visitors'],
  chat_visitors:   ['events', 'occurred_at', `name = 'page_view' AND channel = 'web' AND page LIKE '/chat%'`, 'count(DISTINCT visitor_id)', 'Opened the chat'],
  codes_requested: ['site_otps', 'created_at', 'true', 'count(*)', 'Sign-in codes asked'],
  sign_ins:        ['event_log', 'created_at', `kind = 'site_sign_in'`, 'count(*)', 'Sign-ins'],
  new_customers:   ['users', 'created_at', `signup_channel = 'web'`, 'count(*)', 'New customers'],
  free_checks:     ['event_log', 'created_at', `kind = 'chat_anon_check'`, 'count(*)', 'Checks before sign-in'],
  checks:          ['event_log', 'created_at', `kind IN ('vehicle_check', 'vehicle_check_repeat') AND detail->>'channel' = 'web'`, 'count(*)', 'Signed-in checks'],
  new_vehicles:    ['vehicles', 'first_seen_at', 'true', 'count(*)', 'New vehicles (all channels)'],
  checkouts:       ['payments', 'created_at', `coalesce(raw->>'channel', 'whatsapp') = 'web'`, 'count(*)', 'Checkouts opened'],
  paid:            ['payments', 'paid_at', WEB_PAID, 'count(*)', 'Paid reports'],
  revenue_paise:   ['payments', 'paid_at', WEB_PAID, 'coalesce(sum(amount_paise), 0)', 'Revenue'],
  failed_tries:    ['events', 'occurred_at', `name = 'payment_failed'`, 'count(*)', 'Failed payment tries'],
  reports:         ['vehicle_reports', 'created_at', 'true', 'count(*)', 'Reports made'],
  emails_sent:     ['customer_emails', 'sent_at', `status = 'sent'`, 'count(*)', 'Customer emails sent'],
};
const LOWER_IS_BETTER = new Set(['failed_tries']);

/* The seven windows, as [from, to] Dates. */
function windows(now = new Date()) {
  const IST = 5.5 * 3600e3;
  const local = new Date(now.getTime() + IST);                         // wall clock in India, as if UTC
  const midnight = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - IST);
  const day = 864e5;
  const monthStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - IST);
  const prevMonthStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1) - IST);
  const into = now - monthStart;
  const prevMonthEnd = monthStart;
  return {
    today: [midnight, now],
    yesterday: [new Date(midnight - day), new Date(now - day)],
    last_week: [new Date(midnight - 7 * day), new Date(now - 7 * day)],
    d7: [new Date(now - 7 * day), now],
    prev7: [new Date(now - 14 * day), new Date(now - 7 * day)],
    mtd: [monthStart, now],
    prev_mtd: [prevMonthStart, new Date(Math.min(prevMonthStart.getTime() + into, prevMonthEnd.getTime()))],
  };
}

const pct = (now, before) => (before ? Math.round(((now - before) / before) * 1000) / 10 : now ? null : 0);

let cache = { at: 0, value: null };
async function all({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 60000) return cache.value;
  const w = windows();
  const names = Object.keys(w);
  const earliest = new Date(Math.min(...names.map((n) => w[n][0].getTime())));
  const params = [earliest, ...names.flatMap((n) => w[n])];
  const out = {};
  await Promise.all(Object.entries(METRICS).map(async ([key, [table, col, where, agg, words]]) => {
    const cols = names.map((n, i) => `${agg.replace(/^count\(/, `count(`)} FILTER (WHERE ${col} >= $${2 + i * 2} AND ${col} < $${3 + i * 2}) AS ${n}`);
    // FILTER works on aggregates; sum() is wrapped so FILTER applies inside coalesce.
    const select = agg.startsWith('coalesce(sum(')
      ? names.map((n, i) => `coalesce(sum(amount_paise) FILTER (WHERE ${col} >= $${2 + i * 2} AND ${col} < $${3 + i * 2}), 0) AS ${n}`).join(', ')
      : cols.join(', ');
    try {
      const r = await db.one(`SELECT ${select} FROM ${table} WHERE ${col} >= $1 AND ${where}`, params);
      const v = Object.fromEntries(names.map((n) => [n, Number(r[n] || 0)]));
      out[key] = {
        words, lower_is_better: LOWER_IS_BETTER.has(key), ...v,
        vs_yesterday: pct(v.today, v.yesterday), vs_last_week: pct(v.today, v.last_week),
        vs_prev7: pct(v.d7, v.prev7), vs_prev_month: pct(v.mtd, v.prev_mtd),
      };
    } catch (e) {
      console.error('[compare] %s: %s', key, e.message);
    }
  }));
  cache = { at: Date.now(), value: { at: new Date().toISOString(), windows: Object.fromEntries(names.map((n) => [n, w[n].map((d) => d.toISOString())])), metrics: out } };
  return cache.value;
}

module.exports = { all, METRICS, windows };
