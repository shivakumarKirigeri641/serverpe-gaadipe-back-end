/**
 * src/admin/business.js — Business Health and Today's Summary (user,
 * 2026-09-25, operations module phase 1).
 * ---------------------------------------------------------------------------
 *   health(q)   every business figure for a period against the one before:
 *               value, previous, absolute and % change, trend — each with
 *               where to click for the rows behind it
 *   summary()   the owner's first screen: today's numbers, three
 *               conversions, today against yesterday, services and alerts
 *
 * Nothing is computed here that is computed elsewhere: the counts are the
 * Command Center's (command.totals), the money the ledger's
 * (src/finance/ledger.js), the services the health checks'
 * (src/admin/health.js). A percentage against a previous period of zero is
 * not a percentage — it is "new" (or "no previous-period data").
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const command = require('./command');
const ledger = require('../finance/ledger');

/** value vs previous, said honestly. */
function change(now, before, { worseUp = false } = {}) {
  if (before == null) return { previous: null, abs: null, pct: null, trend: 'none', note: 'No comparison' };
  const abs = now - before;
  if (!before) {
    return { previous: before, abs, pct: null, trend: now ? 'up' : 'flat', note: now ? 'New' : 'No previous-period data', good: now ? !worseUp : null };
  }
  const trend = abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat';
  // Against a loss, a percentage says nothing true ("+28,372%"): the change in rupees only.
  if (before < 0) return { previous: before, abs, pct: null, trend, note: 'Previous period was a loss', good: trend === 'flat' ? null : (trend === 'up') !== worseUp };
  const pct = Math.round((abs / before) * 1000) / 10;
  return { previous: before, abs, pct, trend, note: null, good: trend === 'flat' ? null : (trend === 'up') !== worseUp };
}

/* Payment attempts: checkouts opened for money (free reports are not attempts). */
async function attempts(from, to) {
  const r = await db.one(
    `SELECT count(*)::int AS n FROM payments
      WHERE created_at >= $1 AND created_at < $2 AND amount_paise > 0 AND coalesce(gateway, '') <> 'free'
        AND coalesce(raw->>'channel', raw->'paid_from'->>'channel', 'whatsapp') = 'web'`, [from, to]);
  return r.n;
}

/* The figures, for one window — the website's (2026-10-07: WhatsApp is retired;
   every comparison is the website's, so the WhatsApp days do not distort it). */
async function figures(from, to) {
  const [t, m, a] = await Promise.all([command.totals(from, to), ledger.periodMoney(from, to, null, { channel: 'website' }), attempts(from, to)]);
  return {
    visitors: t.visitors, searches: t.searches, sign_ins: t.sign_ins, lookups: t.api_calls,
    reports: t.reports, attempts: a, paid: m.payments, revenue: m.gross_paise,
    api_cost: m.api_cost_total_paise, messaging_cost: m.messaging_paise, gateway_cost: m.gateway_paise,
    gst: m.gst_paise, refunds: m.refund_paise, net: m.net_paise, margin: m.margin_pct,
    free_reports: m.free_reports, fees_estimated: m.fees_estimated,
  };
}

/* What each figure is, whether up is bad, and where its rows are. */
const METRICS = [
  ['visitors', 'Visitors', 'Different browsers that opened the website.', {}, '/web/visitors'],
  ['searches', 'Vehicle checks', 'Vehicle numbers checked on the website — free chat checks and signed-in checks.', {}, '/web/free-checks'],
  ['sign_ins', 'Sign-ins', 'Customers who signed in on the website.', {}, '/web/customers'],
  ['lookups', 'Government lookups', 'Calls to the Government records, found or not.', {}, '/api-monitor'],
  ['reports', 'Reports generated', 'Full reports (PDF) issued for website payments.', {}, '/documents'],
  ['attempts', 'Payment attempts', 'Checkouts opened for a paid report on the website.', {}, '/payments'],
  ['paid', 'Successful payments', 'Website payments completed (free reports not counted).', {}, '/profitability'],
  ['revenue', 'Revenue', 'What customers paid on the website, GST included.', { money: true }, '/profitability'],
  ['gst', 'GST', 'Output GST inside that revenue — from the tax invoices.', { money: true, worseUp: true }, '/finance'],
  ['gateway_cost', 'Payment gateway cost', 'Razorpay’s fee and its GST — actual where Razorpay gave it.', { money: true, worseUp: true }, '/profitability'],
  ['api_cost', 'API cost', 'Every Government-records call in the period.', { money: true, worseUp: true }, '/api-monitor'],
  ['messaging_cost', 'SMS cost', 'Sign-in codes by SMS, at the rate in Settings.', { money: true, worseUp: true }, '/profitability'],
  ['refunds', 'Refunds', 'Money returned to customers.', { money: true, worseUp: true }, '/payments?status=refunded'],
  ['net', 'Net contribution', 'Website revenue after GST, the gateway, refunds, API and SMS.', { money: true }, '/profitability'],
];

async function health(q = {}) {
  const r = command.resolve({ range: q.range || 'today', from: q.from, to: q.to, compare: q.compare || 'previous' });
  const [cur, prev] = await Promise.all([figures(r.from, r.to), r.prevFrom ? figures(r.prevFrom, r.prevTo) : null]);
  return {
    range: { label: r.label, from: r.from, to: r.to, range: r.range },
    compare: r.prevFrom ? { label: r.compareLabel, from: r.prevFrom, to: r.prevTo } : null,
    metrics: METRICS.map(([key, label, note, o, to]) => ({
      key, label, about: note, money: Boolean(o.money), worse_up: Boolean(o.worseUp), to,
      value: cur[key], ...change(cur[key], prev ? prev[key] : null, { worseUp: o.worseUp }),
    })),
    margin_pct: cur.margin, previous_margin_pct: prev ? prev.margin : null,
    free_reports: cur.free_reports, fees_estimated: cur.fees_estimated,
    referral: 'GaadiPe has no referral programme for now — referral revenue and rewards are not shown.',
  };
}

/* Distinct people at each step today, for the three conversions. */
/* The website's journey today: visits → checked a vehicle → signed in → paid
   (the same visits, from admin/analytics.js — 2026-10-07). */
async function conversions(from, to) {
  const visits = await require('./analytics').perVisit({ from, to });
  // Each step counts only visits that also made the step before it.
  const checked = visits.filter((v) => v.at.searched);
  const signedIn = checked.filter((v) => v.user_id);
  return {
    visitors: visits.length,
    checkers: checked.length,
    signed_in: signedIn.length,
    payers: signedIn.filter((v) => v.at.paid).length,
  };
}
const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

async function summary() {
  const r = command.resolve({ range: 'today', compare: 'previous' });
  const [today, yday, conv, services, alerts] = await Promise.all([
    figures(r.from, r.to), figures(r.prevFrom, r.prevTo), conversions(r.from, r.to),
    require('./health').services().catch(() => null),
    db.one(`SELECT count(*) FILTER (WHERE severity = 'critical')::int AS critical,
                   count(*) FILTER (WHERE severity = 'warning')::int AS warning,
                   count(*) FILTER (WHERE severity NOT IN ('critical', 'warning'))::int AS info
              FROM admin_alerts WHERE status IN ('open', 'acknowledged')`),
  ]);
  const pick = ['website', 'database', 'records_api', 'payment_gateway', 'jobs'];
  return {
    at: new Date(),
    today: {
      visitors: today.visitors, searches: today.searches, sign_ins: today.sign_ins, reports: today.reports,
      paid: today.paid, revenue: today.revenue, gst: today.gst, gateway_cost: today.gateway_cost,
      api_cost: today.api_cost, messaging_cost: today.messaging_cost, refunds: today.refunds, net: today.net,
    },
    conversion: [
      { label: 'Visit → Vehicle check', from: conv.visitors, to: conv.checkers, pct: rate(conv.checkers, conv.visitors), note: 'Website visits that checked a vehicle.' },
      { label: 'Vehicle check → Sign-in', from: conv.checkers, to: conv.signed_in, pct: rate(conv.signed_in, conv.checkers), note: 'Visits that checked a vehicle and signed in.' },
      { label: 'Sign-in → Payment', from: conv.signed_in, to: conv.payers, pct: rate(conv.payers, conv.signed_in), note: 'Signed-in visits that paid.' },
    ],
    comparison: [
      ['revenue', 'Revenue', true], ['paid', 'Paid reports'], ['visitors', 'Visitors'], ['searches', 'Vehicle checks'],
      ['net', 'Net contribution', true],
    ].map(([k, label, money]) => ({ key: k, label, money: Boolean(money), value: today[k], ...change(today[k], yday[k]) })),
    compare_label: 'Today so far vs yesterday to the same time',
    // Free monitoring for one vehicle (2026-10-10, site/freeMonitor.js): the last 30 days.
    free_monitor: await require('../site/freeMonitor').stats({ days: 30 }).catch(() => null),
    system: services ? services.services.filter((s) => pick.includes(s.key)).map((s) => ({ key: s.key, name: s.name, level: s.level, message: s.message }))
      : null,
    alerts,
  };
}

module.exports = { health, summary, change };
