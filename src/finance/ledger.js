/**
 * src/finance/ledger.js — THE money. Every figure the admin panel shows about
 * revenue, GST, gateway fees, costs and contribution comes from here, so one
 * payment has one net wherever it is read (user, 2026-09-25, operations
 * module phase 1).
 * ---------------------------------------------------------------------------
 *   entries({from, to, …})  one row per payment: gross → GST → net sales →
 *                           gateway fee and its GST → API cost → WhatsApp
 *                           cost → refund → net contribution, margin
 *   periodMoney(from, to)   the business view of a period: revenue, GST,
 *                           gateway, refunds and EVERY cost in it, attributed
 *                           to a payment or not
 *   rates()                 the rates in force (GST %, fee estimate, message
 *                           cost), read from the database — never hard-coded
 *
 * WHERE EACH FIGURE COMES FROM, in order of preference:
 *   GST             the payment's own tax invoice (total − base); otherwise
 *                   gross × rate / (100 + rate) with the active GST rate
 *   gateway fee     Razorpay's own fee and tax on the payment (stored with
 *                   it at capture); otherwise the fee % in Settings, and the
 *                   row says "estimated"
 *   API cost        api_calls for this vehicle made for this customer from
 *                   24 hours before the payment to an hour after it, plus
 *                   unattributed calls for the vehicle in the hour after
 *                   payment (the report being issued)
 *   WhatsApp cost   business-initiated (template) messages to the customer in
 *                   the same window × the per-message cost in Settings —
 *                   an estimate until Meta's billing is imported
 *   refund          the payment's amount, when it was refunded
 *   referral reward none: GaadiPe has no referral programme for now (user,
 *                   2026-09-25); the figure is ₹0 and not shown
 *
 * Free reports (₹0, gateway "free") are included with their costs so the
 * cost of giving reports away is visible; `kind` says which is which.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const settings = require('../util/settings');

async function rates() {
  const gst = await db.one(
    `SELECT percent FROM gst_percentages WHERE is_active
        AND (effective_from IS NULL OR effective_from <= now()::date)
        AND (effective_to IS NULL OR effective_to >= now()::date)
      ORDER BY effective_from DESC NULLS LAST LIMIT 1`).catch(() => null);
  return {
    gst_percent: gst ? Number(gst.percent) : 18,
    fee_percent: await settings.num('razorpay_fee_percent', 2),
    fee_gst_percent: await settings.num('razorpay_fee_gst_percent', 18),
    wa_rate_paise: await settings.num('whatsapp_message_cost_paise', 11),
    sms_rate_paise: await settings.num('sms_otp_cost_paise', 25),
  };
}

const ENTRY_SQL = (where) => `
  SELECT p.id, p.payment_id, p.order_id, p.status, p.gateway, p.amount_paise, p.created_at, p.paid_at,
         p.refunded_at, p.refund_id, p.user_id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS person_name,
         v.id AS vehicle_id, v.reg_no,
         (p.raw ? 'free') OR p.gateway = 'free' OR p.amount_paise = 0 AS is_free,
         (p.raw->'gateway'->>'fee')::int AS rzp_fee, (p.raw->'gateway'->>'tax')::int AS rzp_tax,
         p.raw->'gateway'->>'method' AS method, (p.raw->'refund'->>'amount')::int AS refund_amount,
         coalesce(p.raw->>'channel', p.raw->'paid_from'->>'channel') AS pay_channel,
         i.invoice_number, i.base_paise, i.total_paise,
         coalesce(api.cost, 0)::int AS api_cost_paise, coalesce(api.calls, 0)::int AS api_calls,
         coalesce(wa.n, 0)::int AS wa_templates,
         ws.attribution, vis.first_touch AS v_first, vis.last_touch AS v_last
    FROM payments p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN vehicles v ON p.raw ? 'vehicle_id' AND v.id::text = p.raw->>'vehicle_id'
    LEFT JOIN invoices i ON i.payment_id = p.id
    LEFT JOIN LATERAL (
      SELECT sum(a.cost_paise) AS cost, count(*) AS calls FROM api_calls a
       WHERE a.reg_no = v.reg_no
         AND ((a.user_id = p.user_id
               AND a.created_at BETWEEN p.created_at - interval '24 hours' AND coalesce(p.paid_at, p.created_at) + interval '1 hour')
           OR (a.user_id IS NULL
               AND a.created_at BETWEEN coalesce(p.paid_at, p.created_at) - interval '5 minutes' AND coalesce(p.paid_at, p.created_at) + interval '1 hour'))) api ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS n FROM whatsapp_messages m
       WHERE m.direction = 'out' AND m.message_type = 'template' AND m.mobile = u.mobile
         AND m.created_at BETWEEN p.created_at - interval '24 hours' AND coalesce(p.paid_at, p.created_at) + interval '1 hour') wa ON true
    LEFT JOIN LATERAL (SELECT attribution FROM whatsapp_sessions s WHERE s.user_id = p.user_id ORDER BY s.id DESC LIMIT 1) ws ON true
    LEFT JOIN LATERAL (SELECT first_touch, last_touch FROM visitors x
                        WHERE x.user_id = p.user_id OR (u.mobile IS NOT NULL AND x.mobile = u.mobile)
                        ORDER BY x.first_seen_at LIMIT 1) vis ON true
   WHERE ${where}`;

const touch = (t) => (t && typeof t === 'object' && Object.keys(t).length ? {
  source: t.source || null, medium: t.medium || null, campaign: t.campaign || null,
  term: t.term || null, content: t.content || null, landing: t.landing || t.landing_page || null,
} : null);

/** One payment's money, from its stored facts and the rates in force. */
function compute(r, R) {
  const gross = Number(r.amount_paise || 0);
  const free = Boolean(r.is_free) || gross === 0;
  const settled = r.status === 'paid' || r.status === 'refunded';
  const g = settled ? gross : 0;
  const gst = !g ? 0 : r.total_paise != null && r.base_paise != null && Number(r.total_paise) === g
    ? Number(r.total_paise) - Number(r.base_paise)
    : Math.round((g * R.gst_percent) / (100 + R.gst_percent));
  let fee = 0; let feeGst = 0; let feeSource = free || !g ? 'none' : 'estimated';
  if (g && !free) {
    if (r.rzp_fee != null) {
      feeGst = Number(r.rzp_tax || 0); fee = Number(r.rzp_fee) - feeGst; feeSource = 'actual';
    } else {
      fee = Math.round(g * (R.fee_percent / 100)); feeGst = Math.round(fee * (R.fee_gst_percent / 100));
    }
  }
  const refunded = r.status === 'refunded' || Boolean(r.refunded_at);
  const refund = refunded ? Math.min(g, Number(r.refund_amount || g)) : 0;
  const refundNet = refund ? refund - Math.round((refund * gst) / (g || 1)) : 0;
  const netSales = g - gst;
  const netRevenue = netSales - refundNet;
  const api = Number(r.api_cost_paise || 0);
  const wa = Number(r.wa_templates || 0) * R.wa_rate_paise;
  const costs = fee + feeGst + api + wa;
  const net = netRevenue - costs;
  const attribution = r.attribution || {};
  const first = touch(attribution.first_touch) || touch(r.v_first);
  const last = touch(attribution.last_touch) || touch(r.v_last) || first;
  const channel = r.pay_channel || (attribution.channel === 'website' ? 'whatsapp' : null) || 'whatsapp';
  return {
    id: String(r.id), payment_id: r.payment_id, order_id: r.order_id, status: r.status,
    kind: free ? 'free' : 'paid', gateway: r.gateway, method: r.method || null,
    created_at: r.created_at, paid_at: r.paid_at, refunded_at: r.refunded_at,
    user_id: r.user_id ? String(r.user_id) : null, mobile: r.mobile, person_name: r.person_name,
    vehicle_id: r.vehicle_id ? String(r.vehicle_id) : null, reg_no: r.reg_no || null,
    invoice_number: r.invoice_number || null,
    gross_paise: g, gst_paise: gst, net_sales_paise: netSales,
    gateway_fee_paise: fee, gateway_gst_paise: feeGst, fee_source: feeSource,
    api_cost_paise: api, api_calls: Number(r.api_calls || 0),
    whatsapp_cost_paise: wa, whatsapp_templates: Number(r.wa_templates || 0),
    refund_paise: refund, net_revenue_paise: netRevenue, costs_paise: costs,
    net_paise: net, margin_pct: netRevenue > 0 ? Math.round((net / netRevenue) * 1000) / 10 : null,
    source: first?.source || 'direct', campaign: first?.campaign || null,
    first_touch: first, last_touch: last,
    last_source: last?.source || first?.source || 'direct', last_campaign: last?.campaign || null,
    channel: channel === 'web' || channel === 'website' ? 'website' : 'whatsapp',
  };
}

/**
 * Settled payments (paid, refunded, free) whose money landed in [from, to).
 * `ids` narrows to particular payments; `all` includes unsettled ones.
 */
async function entries({ from, to, ids, all = false } = {}) {
  const args = []; const w = [];
  const bind = (v) => { args.push(v); return `$${args.length}`; };
  if (ids?.length) w.push(`p.id = ANY(${bind(ids.map(Number))}::bigint[])`);
  if (from) w.push(`coalesce(p.paid_at, p.created_at) >= ${bind(from)}`);
  if (to) w.push(`coalesce(p.paid_at, p.created_at) < ${bind(to)}`);
  if (!all) w.push(`p.status IN ('paid', 'refunded')`);
  const R = await rates();
  const { rows } = await db.query(`${ENTRY_SQL(w.join(' AND ') || 'true')} ORDER BY coalesce(p.paid_at, p.created_at) DESC, p.id DESC`, args);
  return { rates: R, rows: rows.map((r) => compute(r, R)) };
}

const sum = (rows, k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);

/** Add up ledger rows. */
function total(rows) {
  const t = {
    payments: rows.filter((r) => r.kind === 'paid').length, free_reports: rows.filter((r) => r.kind === 'free').length,
    gross_paise: sum(rows, 'gross_paise'), gst_paise: sum(rows, 'gst_paise'), net_sales_paise: sum(rows, 'net_sales_paise'),
    gateway_fee_paise: sum(rows, 'gateway_fee_paise'), gateway_gst_paise: sum(rows, 'gateway_gst_paise'),
    api_cost_paise: sum(rows, 'api_cost_paise'), whatsapp_cost_paise: sum(rows, 'whatsapp_cost_paise'),
    refund_paise: sum(rows, 'refund_paise'), net_revenue_paise: sum(rows, 'net_revenue_paise'),
    costs_paise: sum(rows, 'costs_paise'), net_paise: sum(rows, 'net_paise'),
    fees_estimated: rows.filter((r) => r.fee_source === 'estimated').length,
  };
  t.gateway_paise = t.gateway_fee_paise + t.gateway_gst_paise;
  t.margin_pct = t.net_revenue_paise > 0 ? Math.round((t.net_paise / t.net_revenue_paise) * 1000) / 10 : null;
  return t;
}

/**
 * The period as a business: the payments' own money, plus every cost in the
 * period that no payment explains — lookups that never became a sale,
 * messages to people who did not buy, sign-in codes.
 */
async function periodMoney(from, to, prefetched) {
  const { rows, rates: R } = prefetched || await entries({ from, to });
  const t = total(rows);
  const [api, wa, sms] = await Promise.all([
    db.one(`SELECT coalesce(sum(cost_paise), 0)::int AS c, count(*)::int AS n FROM api_calls WHERE created_at >= $1 AND created_at < $2`, [from, to]),
    db.one(`SELECT count(*)::int AS n FROM whatsapp_messages WHERE direction = 'out' AND message_type = 'template'
             AND created_at >= $1 AND created_at < $2`, [from, to]),
    db.one(`SELECT count(*)::int AS n FROM site_otps WHERE created_at >= $1 AND created_at < $2`, [from, to]).catch(() => ({ n: 0 })),
  ]);
  const apiAll = api.c;
  const waAll = wa.n * R.wa_rate_paise;
  const smsAll = sms.n * R.sms_rate_paise;
  const unattributed = Math.max(0, apiAll - t.api_cost_paise) + Math.max(0, waAll - t.whatsapp_cost_paise) + smsAll;
  const net = t.net_revenue_paise - t.gateway_paise - Math.max(apiAll, t.api_cost_paise)
    - Math.max(waAll, t.whatsapp_cost_paise) - smsAll;
  return {
    ...t,
    revenue_paise: t.gross_paise,
    api_cost_total_paise: Math.max(apiAll, t.api_cost_paise), api_calls: api.n,
    whatsapp_cost_total_paise: Math.max(waAll, t.whatsapp_cost_paise), whatsapp_templates: wa.n,
    sms_cost_paise: smsAll, messaging_paise: Math.max(waAll, t.whatsapp_cost_paise) + smsAll,
    transactions_net_paise: t.net_paise, unattributed_cost_paise: unattributed,
    net_paise: net,
    margin_pct: t.net_revenue_paise > 0 ? Math.round((net / t.net_revenue_paise) * 1000) / 10 : null,
    rates: R,
  };
}

module.exports = { entries, total, periodMoney, rates, compute };
