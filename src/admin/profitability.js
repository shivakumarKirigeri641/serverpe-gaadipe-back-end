/**
 * src/admin/profitability.js — Profitability, the transaction table, one
 * transaction whole, and the finance / GST export (user, 2026-09-25,
 * operations module phase 1). Every rupee comes from src/finance/ledger.js.
 * ---------------------------------------------------------------------------
 *   overview(q)      totals, and revenue / costs / net / margin by day, week,
 *                    month, source, campaign, channel and paid-vs-free
 *   transactions(q)  the ledger's rows: search, filters, sort, pages
 *   transaction(id)  one payment with everything around it
 *   exportCsv(q)     the ledger as CSV — the same rows, the same figures
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const command = require('./command');
const ledger = require('../finance/ledger');

const period = (q) => command.resolve({ range: q.range || '30d', from: q.from, to: q.to, compare: 'none' });

/* IST day / week / month label for a moment. */
function bucket(at, grain) {
  const d = new Date(new Date(at).getTime() + 330 * 60000);
  if (grain === 'month') return d.toISOString().slice(0, 7);
  if (grain === 'week') {
    const dow = (d.getUTCDay() + 6) % 7;             // Monday first
    return new Date(d.getTime() - dow * 86400000).toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

const SOURCE_WORD = { direct: 'Direct', google_ads: 'Google Ads', meta_ads: 'Meta Ads', google: 'Google (organic)',
  organic: 'Organic search', social: 'Social', whatsapp: 'WhatsApp', referral: 'Referring site' };

function group(rows, keyOf) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r) ?? 'Not recorded';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].map(([key, rs]) => {
    const t = ledger.total(rs);
    return { key, label: SOURCE_WORD[key] || key, payments: t.payments, free: t.free_reports,
      // Everything between what was paid and what is left: GST, refunds (net of
      // their GST), the gateway, API and messaging — so revenue − costs = net.
      revenue_paise: t.gross_paise, costs_paise: t.gst_paise + (t.net_sales_paise - t.net_revenue_paise) + t.costs_paise,
      gst_paise: t.gst_paise, gateway_paise: t.gateway_paise, api_cost_paise: t.api_cost_paise, whatsapp_cost_paise: t.whatsapp_cost_paise,
      refund_paise: t.refund_paise, net_paise: t.net_paise, margin_pct: t.margin_pct };
  });
}

async function overview(q = {}) {
  const r = period(q);
  const data = await ledger.entries({ from: r.from, to: r.to });
  const money = await ledger.periodMoney(r.from, r.to, data);
  const rows = data.rows;
  const grain = ['day', 'week', 'month'].includes(q.grain) ? q.grain : (r.to - r.from > 62 * 86400000 ? 'month' : 'day');
  const series = group(rows, (x) => bucket(x.paid_at || x.created_at, grain)).sort((a, b) => a.key.localeCompare(b.key));
  return {
    range: { label: r.label, from: r.from, to: r.to },
    totals: {
      gross_paise: money.gross_paise, gst_paise: money.gst_paise, net_revenue_paise: money.net_revenue_paise,
      gateway_paise: money.gateway_paise, api_cost_paise: money.api_cost_total_paise, messaging_paise: money.messaging_paise,
      refund_paise: money.refund_paise,
      total_costs_paise: money.gateway_paise + money.api_cost_total_paise + money.messaging_paise,
      net_paise: money.net_paise, margin_pct: money.margin_pct,
      transactions_net_paise: money.transactions_net_paise, unattributed_cost_paise: money.unattributed_cost_paise,
      payments: money.payments, free_reports: money.free_reports, fees_estimated: money.fees_estimated,
    },
    grain, series,
    by_source: group(rows, (x) => x.source).sort((a, b) => b.revenue_paise - a.revenue_paise),
    by_campaign: group(rows, (x) => x.campaign || '(no campaign)').sort((a, b) => b.revenue_paise - a.revenue_paise),
    by_channel: group(rows, (x) => (x.channel === 'website' ? 'Website' : 'WhatsApp')),
    by_kind: group(rows, (x) => (x.kind === 'free' ? 'Free reports' : 'Paid reports')),
    rates: money.rates,
    notes: {
      referral: 'Referral rewards: none — GaadiPe has no referral programme for now.',
      whatsapp: `WhatsApp cost is estimated at ₹${(money.rates.wa_rate_paise / 100).toFixed(2)} per business-initiated message (Settings) until Meta billing is imported.`,
      fees: money.fees_estimated ? `${money.fees_estimated} payment(s) have no fee from Razorpay yet — their fee is estimated at ${money.rates.fee_percent}% + GST.` : null,
    },
  };
}

const SORTS = {
  date: (x) => new Date(x.paid_at || x.created_at).getTime(), gross: (x) => x.gross_paise, net: (x) => x.net_paise,
  margin: (x) => x.margin_pct ?? -1e9, api: (x) => x.api_cost_paise, fee: (x) => x.gateway_fee_paise + x.gateway_gst_paise,
};

async function transactions(q = {}) {
  const r = period(q);
  let rows = (await ledger.entries({ from: r.from, to: r.to })).rows;
  const term = String(q.q || '').trim();
  if (term) {
    const t = term.toUpperCase().replace(/[\s-]/g, '');
    const digits = term.replace(/\D/g, '');
    rows = rows.filter((x) => x.id === term || (x.payment_id || '').toUpperCase().includes(t) || (x.order_id || '').toUpperCase().includes(t)
      || (x.reg_no || '').includes(t) || (x.invoice_number || '').toUpperCase().includes(t)
      || (digits.length >= 4 && (x.mobile || '').includes(digits)));
  }
  if (q.kind) rows = rows.filter((x) => x.kind === q.kind);
  if (q.status) rows = rows.filter((x) => x.status === q.status);
  if (q.source) rows = rows.filter((x) => x.source === q.source);
  if (q.channel) rows = rows.filter((x) => x.channel === q.channel);
  if (q.fee === 'estimated') rows = rows.filter((x) => x.fee_source === 'estimated');
  if (q.loss === '1') rows = rows.filter((x) => x.net_paise < 0);
  const key = SORTS[q.sort] ? q.sort : 'date';
  const dir = q.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => (SORTS[key](a) - SORTS[key](b)) * dir);
  const limit = Math.min(200, Number(q.limit) || 50); const offset = Math.max(0, Number(q.offset) || 0);
  return {
    range: { label: r.label }, total: rows.length, totals: ledger.total(rows),
    sources: [...new Set(rows.map((x) => x.source))],
    rows: rows.slice(offset, offset + limit),
  };
}

/** One transaction: the ledger row, and the customer, vehicle, report, invoice, events and API calls behind it. */
async function transaction(id) {
  const { rows } = await ledger.entries({ ids: [id], all: true });
  const e = rows[0];
  if (!e) return null;
  const p = await db.one(`SELECT p.*, pl.name AS plan_name FROM payments p LEFT JOIN plans pl ON pl.id = p.plan_id WHERE p.id = $1`, [id]);
  const [events, report, invoice, calls] = await Promise.all([
    db.query(`SELECT id, occurred_at, name, channel, status, amount_paise, metadata FROM events
               WHERE payment_id = $1 OR (user_id = $2 AND occurred_at BETWEEN $3::timestamptz - interval '2 hours' AND coalesce($4::timestamptz, $3::timestamptz) + interval '2 hours'
                     AND (reg_no = $5 OR reg_no IS NULL) AND payment_id IS NULL)
               ORDER BY occurred_at LIMIT 300`, [id, p.user_id, p.created_at, p.paid_at, e.reg_no]),
    db.one(`SELECT id, report_number, created_at, channel, valid_until FROM vehicle_reports WHERE payment_id = $1`, [id]),
    db.one(`SELECT id, invoice_number, invoice_date, base_paise, total_paise, gst_percent, cgst_paise, sgst_paise, igst_paise, place_of_supply
              FROM invoices WHERE payment_id = $1`, [id]),
    e.reg_no ? db.query(`SELECT id, created_at, dataset, provider_path, cache_hit, ok, duration_ms, cost_paise FROM api_calls
                          WHERE reg_no = $1 AND created_at BETWEEN $2::timestamptz - interval '24 hours' AND coalesce($3::timestamptz, $2::timestamptz) + interval '1 hour'
                          ORDER BY created_at`, [e.reg_no, p.created_at, p.paid_at]) : { rows: [] },
  ]);
  const gw = p.raw?.gateway && typeof p.raw.gateway === 'object' ? p.raw.gateway : {};
  return {
    ledger: e,
    payment: {
      id: String(p.id), status: p.status, plan: p.plan_name, gateway: p.gateway, order_id: p.order_id, payment_id: p.payment_id,
      refund_id: p.refund_id, created_at: p.created_at, paid_at: p.paid_at, refunded_at: p.refunded_at,
      method: gw.method || null, bank: gw.bank || null, wallet: gw.wallet || null, vpa_present: Boolean(gw.vpa),
      gateway_status: gw.status || null, gateway_amount_paise: gw.amount ?? null, captured: gw.captured ?? null,
      error_code: gw.error_code || null, error_reason: gw.error_reason || null, error_description: gw.error_description || null,
      buyer_state: p.raw?.buyer_state_code || null,
    },
    report: report ? { ...report, id: String(report.id) } : null,
    invoice: invoice ? { ...invoice, id: String(invoice.id) } : null,
    events: events.rows.map((x) => ({ ...x, id: String(x.id) })),
    api_calls: calls.rows.map((x) => ({ ...x, id: String(x.id) })),
    rules: {
      gst: e.invoice_number ? 'From the tax invoice.' : 'Worked out at the active GST rate (no invoice found).',
      fee: e.fee_source === 'actual' ? 'Razorpay’s own fee and tax on this payment.' : e.fee_source === 'estimated' ? 'Estimated from the fee % in Settings — Razorpay has not given the fee for this payment.' : 'No gateway fee (free report).',
      api: 'Records-API calls for this vehicle for this customer from 24 hours before the payment to an hour after it, plus the report being issued.',
      whatsapp: 'Business-initiated WhatsApp messages to this customer in the same window, at the per-message cost in Settings.',
    },
  };
}

/* The export: the ledger's columns, one row per transaction. */
const COLUMNS = [
  ['Transaction ID', (x) => x.id], ['Gateway payment ID', (x) => x.payment_id], ['Order ID', (x) => x.order_id],
  ['Invoice', (x) => x.invoice_number], ['Date (IST)', (x) => x.paid_at || x.created_at], ['Customer', (x) => x.mobile],
  ['Vehicle', (x) => x.reg_no], ['Kind', (x) => x.kind], ['Status', (x) => x.status], ['Source', (x) => x.source],
  ['Campaign', (x) => x.campaign], ['Channel', (x) => x.channel],
  ['Gross amount', (x) => x.gross_paise], ['GST', (x) => x.gst_paise], ['Net amount', (x) => x.net_sales_paise],
  ['Gateway fee', (x) => x.gateway_fee_paise], ['Gateway GST', (x) => x.gateway_gst_paise], ['Fee source', (x) => x.fee_source],
  ['API cost', (x) => x.api_cost_paise], ['WhatsApp cost', (x) => x.whatsapp_cost_paise], ['Refund', (x) => x.refund_paise],
  ['Net contribution', (x) => x.net_paise], ['Margin %', (x) => x.margin_pct],
];
const MONEY = new Set(['Gross amount', 'GST', 'Net amount', 'Gateway fee', 'Gateway GST', 'API cost', 'WhatsApp cost', 'Refund', 'Net contribution']);
const cell = (v) => {
  if (v == null) return '';
  const s = v instanceof Date ? new Date(v.getTime() + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ') : String(v);
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

async function exportCsv(q = {}, { mask = true } = {}) {
  const r = period(q);
  const { rows } = await ledger.entries({ from: r.from, to: r.to });
  const maskM = (m) => { const d = String(m || '').replace(/\D/g, ''); return d.length >= 10 ? `XXXXXX${d.slice(-4)}` : m; };
  const out = rows.map((x) => COLUMNS.map(([h, f]) => {
    let v = f(x);
    if (h === 'Customer' && mask) v = maskM(v);
    if (MONEY.has(h) && v != null) v = (Number(v) / 100).toFixed(2);
    return cell(v);
  }).join(','));
  const t = ledger.total(rows);
  const totalLine = COLUMNS.map(([h]) => {
    const k = { 'Gross amount': 'gross_paise', GST: 'gst_paise', 'Net amount': 'net_sales_paise', 'Gateway fee': 'gateway_fee_paise',
      'Gateway GST': 'gateway_gst_paise', 'API cost': 'api_cost_paise', 'WhatsApp cost': 'whatsapp_cost_paise', Refund: 'refund_paise', 'Net contribution': 'net_paise' }[h];
    return h === 'Transaction ID' ? 'TOTAL' : k ? (t[k] / 100).toFixed(2) : '';
  }).join(',');
  return { csv: [COLUMNS.map(([h]) => h).join(','), ...out, totalLine].join('\r\n'), rows: rows.length, range: r.label };
}

module.exports = { overview, transactions, transaction, exportCsv };
