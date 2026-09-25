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
      WHERE created_at >= $1 AND created_at < $2 AND amount_paise > 0 AND coalesce(gateway, '') <> 'free'`, [from, to]);
  return r.n;
}

/* The figures, for one window. */
async function figures(from, to) {
  const [t, m, a] = await Promise.all([command.totals(from, to), ledger.periodMoney(from, to), attempts(from, to)]);
  return {
    visitors: t.visitors, searches: t.wa_vehicles, conversations: t.chatting, lookups: t.searches,
    reports: t.reports, attempts: a, paid: m.payments, revenue: m.gross_paise,
    api_cost: m.api_cost_total_paise, whatsapp_cost: m.messaging_paise, gateway_cost: m.gateway_paise,
    gst: m.gst_paise, refunds: m.refund_paise, net: m.net_paise, margin: m.margin_pct,
    free_reports: m.free_reports, fees_estimated: m.fees_estimated,
  };
}

/* What each figure is, whether up is bad, and where its rows are. */
const METRICS = [
  ['visitors', 'Visitors', 'Different browsers that opened the website.', {}, '/journey'],
  ['searches', 'Vehicle searches', 'Vehicle numbers people sent on WhatsApp.', {}, '/lookups'],
  ['conversations', 'WhatsApp conversations', 'Different people who wrote to GaadiPe on WhatsApp.', {}, '/whatsapp'],
  ['lookups', 'Vehicle lookups', 'Searches answered from the Government records, found or not.', {}, '/lookups'],
  ['reports', 'Reports generated', 'Full reports (PDF) issued.', {}, '/documents'],
  ['attempts', 'Payment attempts', 'Checkouts opened for a paid report.', {}, '/payments'],
  ['paid', 'Successful payments', 'Payments completed (free reports not counted).', {}, '/profitability'],
  ['revenue', 'Revenue', 'What customers paid, GST included.', { money: true }, '/profitability'],
  ['gst', 'GST', 'Output GST inside that revenue — from the tax invoices.', { money: true, worseUp: true }, '/finance'],
  ['gateway_cost', 'Payment gateway cost', 'Razorpay’s fee and its GST — actual where Razorpay gave it.', { money: true, worseUp: true }, '/profitability'],
  ['api_cost', 'API cost', 'Every Government-records call in the period.', { money: true, worseUp: true }, '/api-monitor'],
  ['whatsapp_cost', 'WhatsApp & SMS cost', 'Business-initiated messages and sign-in codes, at the rates in Settings.', { money: true, worseUp: true }, '/whatsapp'],
  ['refunds', 'Refunds', 'Money returned to customers.', { money: true, worseUp: true }, '/payments?status=refunded'],
  ['net', 'Net contribution', 'Revenue after GST, the gateway, refunds, API and messaging.', { money: true }, '/profitability'],
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
async function conversions(from, to) {
  return db.one(
    `SELECT count(DISTINCT e.visitor_id) FILTER (WHERE e.channel = 'web')::int AS visitors,
            count(DISTINCT e.visitor_id) FILTER (WHERE e.name = 'whatsapp_cta_clicked')::int AS wa_clickers,
            count(DISTINCT coalesce(e.mobile, e.user_id::text)) FILTER (WHERE e.name = 'whatsapp_message_received')::int AS chatters,
            count(DISTINCT coalesce(e.mobile, e.user_id::text)) FILTER (WHERE e.name = 'whatsapp_vehicle_received')::int AS senders,
            count(DISTINCT coalesce(e.mobile, e.user_id::text)) FILTER (WHERE e.name = 'payment_success')::int AS payers
       FROM events e WHERE e.occurred_at >= $1 AND e.occurred_at < $2`, [from, to]);
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
  const pick = ['website', 'database', 'records_api', 'whatsapp_api', 'payment_gateway', 'jobs'];
  return {
    at: new Date(),
    today: {
      visitors: today.visitors, searches: today.searches, conversations: today.conversations, reports: today.reports,
      paid: today.paid, revenue: today.revenue, gst: today.gst, gateway_cost: today.gateway_cost,
      api_cost: today.api_cost, whatsapp_cost: today.whatsapp_cost, refunds: today.refunds, net: today.net,
    },
    conversion: [
      { label: 'Visitor → WhatsApp', from: conv.visitors, to: conv.wa_clickers, pct: rate(conv.wa_clickers, conv.visitors), note: 'Website visitors who tapped through to WhatsApp.' },
      { label: 'WhatsApp → Vehicle', from: conv.chatters, to: conv.senders, pct: rate(conv.senders, conv.chatters), note: 'People who wrote and then sent a vehicle number.' },
      { label: 'Vehicle → Payment', from: conv.senders, to: conv.payers, pct: rate(conv.payers, conv.senders), note: 'People who sent a vehicle number and then paid.' },
    ],
    comparison: [
      ['revenue', 'Revenue', true], ['paid', 'Paid reports'], ['visitors', 'Visitors'], ['conversations', 'WhatsApp'],
      ['net', 'Net contribution', true],
    ].map(([k, label, money]) => ({ key: k, label, money: Boolean(money), value: today[k], ...change(today[k], yday[k]) })),
    compare_label: 'Today so far vs yesterday to the same time',
    system: services ? services.services.filter((s) => pick.includes(s.key)).map((s) => ({ key: s.key, name: s.name, level: s.level, message: s.message }))
      : null,
    alerts,
  };
}

module.exports = { health, summary, change };
