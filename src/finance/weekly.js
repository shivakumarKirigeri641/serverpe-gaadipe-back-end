/**
 * src/finance/weekly.js — the weekly money report, as an Excel file (user,
 * 2026-10-01). Sent every Saturday morning by jobs/notify.js; also runs by
 * hand: `node scripts/finance-weekly.js`.
 * ---------------------------------------------------------------------------
 * The week is Saturday 00:00 to Friday 23:59 IST, just ended. Every figure is
 * the finance ledger's (src/finance/ledger.js), so it matches the admin panel:
 *
 *   gross, GST     what customers paid, and the GST in it (CGST/SGST/IGST from
 *                  the tax invoices themselves)
 *   Razorpay       its fee and the GST on it — Razorpay's own figure where it
 *                  reported one, else razorpay_fee_percent (2.2%) + 18%
 *   WhatsApp       business-started (template) messages by Meta category:
 *                  utility ₹0.11, marketing ₹0.85 (Settings). Replies inside
 *                  the 24-hour window are free and counted separately.
 *   vehicle API    every records-API call in the week, sold or not
 *   SMS            sign-in codes
 *   fleets         fleet payments, with their own GST and estimated fee
 *
 * Sheets: Summary (this week against last) · Daily · Payments · WhatsApp ·
 * Fleets · Rates.
 * ---------------------------------------------------------------------------
 */

const ExcelJS = require('exceljs');
const db = require('../db');
const ledger = require('./ledger');

const IST = 5.5 * 3600 * 1000;
const rs = (p) => Math.round(Number(p || 0)) / 100;          // paise → rupees, for the sheet
const day = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const label = (d) => new Date(new Date(d).getTime() + IST).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });

/** The Saturday-to-Friday week that ended before `at` (IST), as UTC instants. */
function lastWeek(at = new Date()) {
  const ist = new Date(at.getTime() + IST);
  const midnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST; // today 00:00 IST
  const sinceSat = (ist.getUTCDay() + 1) % 7;                  // days since the most recent Saturday
  const to = new Date(midnight - sinceSat * 86400e3);          // that Saturday 00:00 IST
  return { from: new Date(to.getTime() - 7 * 86400e3), to };
}

async function figures(from, to) {
  const pre = await ledger.entries({ from, to });
  const money = await ledger.periodMoney(from, to, pre);
  const R = pre.rates;
  const [gst, wa, waFree, api, fleet, sms] = await Promise.all([
    db.one(`SELECT coalesce(sum(i.cgst_paise), 0)::int AS cgst, coalesce(sum(i.sgst_paise), 0)::int AS sgst, coalesce(sum(i.igst_paise), 0)::int AS igst
              FROM invoices i JOIN payments p ON p.id = i.payment_id
             WHERE p.status IN ('paid', 'refunded') AND coalesce(p.paid_at, p.created_at) >= $1 AND coalesce(p.paid_at, p.created_at) < $2`, [from, to]),
    db.query(`SELECT m.template_name, upper(coalesce(t.category, 'UNKNOWN')) AS category, count(*)::int AS n,
                     min(m.created_at) AS first_at, max(m.created_at) AS last_at
                FROM whatsapp_messages m
                LEFT JOIN LATERAL (SELECT category FROM wa_templates x WHERE x.template_name = m.template_name LIMIT 1) t ON true
               WHERE m.direction = 'out' AND m.message_type = 'template' AND m.created_at >= $1 AND m.created_at < $2
               GROUP BY 1, 2 ORDER BY 3 DESC`, [from, to]),
    db.one(`SELECT count(*)::int AS n FROM whatsapp_messages
             WHERE direction = 'out' AND message_type <> 'template' AND created_at >= $1 AND created_at < $2`, [from, to]),
    db.query(`SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d, count(*)::int AS n, coalesce(sum(cost_paise), 0)::int AS c
                FROM api_calls WHERE created_at >= $1 AND created_at < $2 AND NOT cache_hit GROUP BY 1`, [from, to]),
    db.query(`SELECT fp.id, fp.paid_at, fp.amount_paise, fp.vehicles, fp.period_days, fp.kind, f.company,
                     i.invoice_number, i.base_paise, i.cgst_paise, i.sgst_paise, i.igst_paise, i.total_paise
                FROM fleet_payments fp JOIN fleets f ON f.id = fp.fleet_id LEFT JOIN invoices i ON i.id = fp.invoice_id
               WHERE fp.status = 'paid' AND fp.paid_at >= $1 AND fp.paid_at < $2 ORDER BY fp.paid_at`, [from, to]).catch(() => ({ rows: [] })),
    db.query(`SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d, count(*)::int AS n
                FROM site_otps WHERE created_at >= $1 AND created_at < $2 GROUP BY 1`, [from, to]).catch(() => ({ rows: [] })),
  ]);

  const rate = (cat) => (cat === 'MARKETING' ? R.wa_marketing_paise : cat === 'UTILITY' ? R.wa_utility_paise
    : cat === 'AUTHENTICATION' ? R.wa_auth_paise : R.wa_rate_paise);
  const waRows = wa.rows.map((w) => ({ ...w, rate: rate(w.category), cost: w.n * rate(w.category) }));
  const byCat = (c) => waRows.filter((w) => w.category === c).reduce((a, w) => ({ n: a.n + w.n, cost: a.cost + w.cost }), { n: 0, cost: 0 });
  const waOther = waRows.filter((w) => w.category !== 'UTILITY' && w.category !== 'MARKETING')
    .reduce((a, w) => ({ n: a.n + w.n, cost: a.cost + w.cost }), { n: 0, cost: 0 });

  const fleets = fleet.rows.map((f) => {
    const gross = Number(f.amount_paise);
    const gstP = f.total_paise != null && f.base_paise != null ? Number(f.total_paise) - Number(f.base_paise)
      : Math.round((gross * R.gst_percent) / (100 + R.gst_percent));
    const fee = Math.round(gross * (R.fee_percent / 100)); const feeGst = Math.round(fee * (R.fee_gst_percent / 100));
    return { ...f, gross, gst: gstP, fee, feeGst, net: gross - gstP - fee - feeGst };
  });
  const fl = fleets.reduce((a, f) => ({ gross: a.gross + f.gross, gst: a.gst + f.gst, fee: a.fee + f.fee, feeGst: a.feeGst + f.feeGst }),
    { gross: 0, gst: 0, fee: 0, feeGst: 0 });

  const smsN = sms.rows.reduce((a, x) => a + x.n, 0);
  const apiN = api.rows.reduce((a, x) => a + x.n, 0);
  const t = {
    payments: money.payments, free_reports: money.free_reports, fleet_payments: fleets.length,
    gross: money.gross_paise + fl.gross,
    gst: money.gst_paise + fl.gst, cgst: gst.cgst, sgst: gst.sgst, igst: gst.igst,
    net_sales: money.net_sales_paise + (fl.gross - fl.gst),
    refunds: money.refund_paise,
    rzp_fee: money.gateway_fee_paise + fl.fee, rzp_gst: money.gateway_gst_paise + fl.feeGst,
    fees_estimated: money.fees_estimated,
    wa_utility: byCat('UTILITY'), wa_marketing: byCat('MARKETING'), wa_other: waOther,
    wa_total: money.whatsapp_cost_total_paise, wa_free: waFree.n,
    api_calls: apiN, api_cost: money.api_cost_total_paise,
    sms: smsN, sms_cost: money.sms_cost_paise,
  };
  t.costs = t.rzp_fee + t.rzp_gst + t.wa_total + t.api_cost + t.sms_cost;
  // Net as the ledger counts it (refunds net of their GST, every cost in the
  // period), plus the fleets' own net.
  t.net = money.net_paise + (fl.gross - fl.gst - fl.fee - fl.feeGst);
  t.margin = t.net_sales > 0 ? Math.round((t.net / t.net_sales) * 1000) / 10 : null;
  // Ads, as entered on the Ad spend page (user, 2026-10-01).
  t.ads = await require('../admin/opsExtras').spendBetween(from, to).catch(() => 0);
  t.net_after_ads = t.net - t.ads;
  t.ads_per_paying = t.ads && t.payments ? Math.round(t.ads / t.payments) : null;

  // One row per IST day.
  const days = [];
  for (let d = new Date(from); d < to; d = new Date(d.getTime() + 86400e3)) days.push(day(d));
  const daily = days.map((d) => {
    const rows = pre.rows.filter((r) => day(r.paid_at || r.created_at) === d);
    const f = fleets.filter((x) => day(x.paid_at) === d);
    const a = api.rows.find((x) => x.d === d);
    const sm = sms.rows.find((x) => x.d === d);
    return {
      date: d, label: label(new Date(`${d}T00:00:00Z`).getTime() - IST),
      payments: rows.filter((r) => r.kind === 'paid').length + f.length,
      gross: rows.reduce((s, r) => s + r.gross_paise, 0) + f.reduce((s, x) => s + x.gross, 0),
      gst: rows.reduce((s, r) => s + r.gst_paise, 0) + f.reduce((s, x) => s + x.gst, 0),
      rzp: rows.reduce((s, r) => s + r.gateway_fee_paise + r.gateway_gst_paise, 0) + f.reduce((s, x) => s + x.fee + x.feeGst, 0),
      api: a ? a.c : 0, api_calls: a ? a.n : 0,
      sms: sm ? sm.n * R.sms_rate_paise : 0,
    };
  });
  // WhatsApp cost per day, by the same rates.
  const waDay = await db.query(
    `SELECT to_char(m.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d, ${ledger.waCostSql('m', R)}::int AS cost
       FROM whatsapp_messages m WHERE m.direction = 'out' AND m.message_type = 'template' AND m.created_at >= $1 AND m.created_at < $2 GROUP BY 1`, [from, to]);
  for (const row of daily) {
    const w = waDay.rows.find((x) => x.d === row.date);
    row.wa = w ? w.cost : 0;
    row.net = row.gross - row.gst - row.rzp - row.api - row.wa - row.sms;
  }
  return { t, R, rows: pre.rows, fleets, waRows, daily };
}

/* ─────────────────────────────────────────────────────────── the workbook ── */

const BRAND = 'FF0F766E';
const MONEY = '"₹"#,##0.00';
function head(ws, cols) {
  ws.columns = cols.map(([header, key, width, fmt]) => ({ header, key, width, style: fmt ? { numFmt: fmt } : {} }));
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  h.alignment = { vertical: 'middle' }; h.height = 22;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}
const totalRow = (row) => { row.font = { bold: true }; row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F2F0' } }; };

async function workbook(cur, prev, { from, to }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GaadiPe'; wb.created = new Date();
  const { t, R } = cur; const p = prev.t;

  // Summary
  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 46 }, { width: 18 }, { width: 18 }, { width: 14 }];
  s.addRow([`GaadiPe — weekly money report`]).font = { bold: true, size: 14, color: { argb: BRAND } };
  s.addRow([`${label(from)} – ${label(to.getTime() - 1)} (IST) · generated ${new Date(Date.now() + IST).toISOString().slice(0, 16).replace('T', ' ')} IST`]).font = { italic: true, color: { argb: 'FF6B7C79' } };
  s.addRow([]);
  const hr = s.addRow(['', 'This week', 'Last week', 'Change']);
  hr.font = { bold: true, color: { argb: 'FFFFFFFF' } }; hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  const line = (name, a, b, { money = true, bold = false, note } = {}) => {
    const r = s.addRow([name, money ? rs(a) : a, money ? rs(b) : b, b ? (a - b) / Math.abs(b) : null]);
    if (money) { r.getCell(2).numFmt = MONEY; r.getCell(3).numFmt = MONEY; }
    r.getCell(4).numFmt = '+0%;-0%;0%';
    if (bold) totalRow(r);
    if (note) r.getCell(1).note = note;
    return r;
  };
  const section = (name) => { const r = s.addRow([name]); r.font = { bold: true, color: { argb: BRAND } }; };
  section('Sales');
  line('Reports paid for', t.payments, p.payments, { money: false });
  line('Free reports', t.free_reports, p.free_reports, { money: false });
  line('Fleet payments', t.fleet_payments, p.fleet_payments, { money: false });
  line('Gross received (incl. GST)', t.gross, p.gross, { bold: true });
  line('  GST collected', t.gst, p.gst);
  line('    of which CGST', t.cgst, p.cgst);
  line('    of which SGST', t.sgst, p.sgst);
  line('    of which IGST', t.igst, p.igst);
  line('Net sales (excl. GST)', t.net_sales, p.net_sales, { bold: true });
  line('Refunds', t.refunds, p.refunds);
  section('Costs');
  line(`Razorpay fee (${R.fee_percent}% where not reported)`, t.rzp_fee, p.rzp_fee,
    { note: t.fees_estimated ? `${t.fees_estimated} payment(s) without Razorpay's own fee yet — estimated.` : 'Razorpay’s own figures.' });
  line(`GST on Razorpay fee (${R.fee_gst_percent}%)`, t.rzp_gst, p.rzp_gst);
  line(`WhatsApp utility — ${t.wa_utility.n} × ₹${rs(R.wa_utility_paise).toFixed(2)}`, t.wa_utility.cost, p.wa_utility.cost);
  line(`WhatsApp marketing — ${t.wa_marketing.n} × ₹${rs(R.wa_marketing_paise).toFixed(2)}`, t.wa_marketing.cost, p.wa_marketing.cost);
  if (t.wa_other.n || p.wa_other.n) line(`WhatsApp other templates — ${t.wa_other.n}`, t.wa_other.cost, p.wa_other.cost);
  line(`  WhatsApp total (+ ${t.wa_free} free replies in the 24-hour window)`, t.wa_total, p.wa_total);
  line(`Vehicle records API — ${t.api_calls} live calls`, t.api_cost, p.api_cost);
  line(`SMS sign-in codes — ${t.sms}`, t.sms_cost, p.sms_cost);
  line('Total costs', t.costs, p.costs, { bold: true });
  section('Result');
  line('Net profit (after GST, refunds and costs)', t.net, p.net, { bold: true });
  const m = s.addRow(['Margin on net sales', t.margin != null ? t.margin / 100 : null, p.margin != null ? p.margin / 100 : null]);
  m.getCell(2).numFmt = '0.0%'; m.getCell(3).numFmt = '0.0%';
  section('After ads');
  line('Meta ads spend (Ad spend page)', t.ads, p.ads);
  line('Net profit after ads', t.net_after_ads, p.net_after_ads, { bold: true });
  line('Ads cost per paying customer', t.ads_per_paying || 0, p.ads_per_paying || 0);
  s.addRow([]);
  s.addRow(['Not included: costs paid outside GaadiPe other than the ad spend entered on the Ad spend page. GST collected is owed to the Government; Razorpay’s GST may be claimable as input credit — ask your CA.']).font = { italic: true, color: { argb: 'FF6B7C79' } };

  // Daily
  const d = wb.addWorksheet('Daily');
  head(d, [['Day', 'label', 16], ['Payments', 'payments', 11], ['Gross', 'gross', 14, MONEY], ['GST', 'gst', 12, MONEY],
    ['Razorpay + GST', 'rzp', 15, MONEY], ['WhatsApp', 'wa', 12, MONEY], ['Vehicle API', 'api', 13, MONEY], ['API calls', 'api_calls', 10],
    ['SMS', 'sms', 9, MONEY], ['Net', 'net', 14, MONEY]]);
  for (const x of cur.daily) d.addRow({ ...x, gross: rs(x.gross), gst: rs(x.gst), rzp: rs(x.rzp), wa: rs(x.wa), api: rs(x.api), sms: rs(x.sms), net: rs(x.net) });
  const dsum = (k) => cur.daily.reduce((a, x) => a + x[k], 0);
  totalRow(d.addRow({ label: 'Total', payments: dsum('payments'), gross: rs(dsum('gross')), gst: rs(dsum('gst')), rzp: rs(dsum('rzp')),
    wa: rs(dsum('wa')), api: rs(dsum('api')), api_calls: dsum('api_calls'), sms: rs(dsum('sms')), net: rs(dsum('net')) }));

  // Payments
  const pay = wb.addWorksheet('Payments');
  head(pay, [['Paid at (IST)', 'at', 18], ['Invoice', 'inv', 18], ['Customer', 'who', 22], ['Vehicle', 'reg', 14], ['Type', 'kind', 8],
    ['Status', 'status', 10], ['Method', 'method', 10], ['Gross', 'gross', 11, MONEY], ['GST', 'gst', 10, MONEY], ['Net sales', 'ns', 11, MONEY],
    ['Razorpay fee', 'fee', 12, MONEY], ['Fee GST', 'feegst', 10, MONEY], ['Fee source', 'feesrc', 10], ['WhatsApp', 'wa', 10, MONEY],
    ['Vehicle API', 'api', 11, MONEY], ['Refund', 'refund', 10, MONEY], ['Net', 'net', 11, MONEY], ['Came from', 'src', 16]]);
  const mask = (m) => (m ? `…${String(m).slice(-4)}` : '');
  for (const r of cur.rows) {
    pay.addRow({ at: new Date(new Date(r.paid_at || r.created_at).getTime() + IST).toISOString().slice(0, 16).replace('T', ' '),
      inv: r.invoice_number || '', who: [r.person_name, mask(r.mobile)].filter(Boolean).join(' · '), reg: r.reg_no || '', kind: r.kind,
      status: r.status, method: r.method || '', gross: rs(r.gross_paise), gst: rs(r.gst_paise), ns: rs(r.net_sales_paise),
      fee: rs(r.gateway_fee_paise), feegst: rs(r.gateway_gst_paise), feesrc: r.fee_source, wa: rs(r.whatsapp_cost_paise),
      api: rs(r.api_cost_paise), refund: rs(r.refund_paise), net: rs(r.net_paise), src: r.source });
  }
  if (!cur.rows.length) pay.addRow({ at: 'No payments this week' });

  // WhatsApp
  const w = wb.addWorksheet('WhatsApp');
  head(w, [['Template', 'name', 34], ['Meta category', 'cat', 16], ['Sent', 'n', 8], ['Rate', 'rate', 10, MONEY], ['Cost', 'cost', 12, MONEY]]);
  for (const x of cur.waRows) w.addRow({ name: x.template_name, cat: x.category, n: x.n, rate: rs(x.rate), cost: rs(x.cost) });
  totalRow(w.addRow({ name: 'Total templates', n: cur.waRows.reduce((a, x) => a + x.n, 0), cost: rs(cur.waRows.reduce((a, x) => a + x.cost, 0)) }));
  w.addRow({ name: `Free replies inside the 24-hour window: ${t.wa_free}`, cost: 0 });

  // Fleets
  const f = wb.addWorksheet('Fleets');
  head(f, [['Paid at (IST)', 'at', 18], ['Company', 'company', 26], ['Invoice', 'inv', 18], ['Vehicles', 'veh', 9], ['Days', 'days', 7],
    ['Gross', 'gross', 12, MONEY], ['GST', 'gst', 11, MONEY], ['Razorpay fee (est.)', 'fee', 14, MONEY], ['Fee GST', 'feegst', 10, MONEY], ['Net', 'net', 12, MONEY]]);
  for (const x of cur.fleets) {
    f.addRow({ at: new Date(new Date(x.paid_at).getTime() + IST).toISOString().slice(0, 16).replace('T', ' '), company: x.company, inv: x.invoice_number || '',
      veh: x.vehicles, days: x.period_days, gross: rs(x.gross), gst: rs(x.gst), fee: rs(x.fee), feegst: rs(x.feeGst), net: rs(x.net) });
  }
  if (!cur.fleets.length) f.addRow({ at: 'No fleet payments this week' });

  // Rates
  const r = wb.addWorksheet('Rates');
  head(r, [['Rate', 'k', 44], ['Value', 'v', 16]]);
  [['GST on reports', `${R.gst_percent}%`], ['Razorpay fee (used where Razorpay has not reported one)', `${R.fee_percent}%`],
    ['GST on the Razorpay fee', `${R.fee_gst_percent}%`], ['WhatsApp utility message', `₹${rs(R.wa_utility_paise).toFixed(2)}`],
    ['WhatsApp marketing message', `₹${rs(R.wa_marketing_paise).toFixed(2)}`], ['WhatsApp other template', `₹${rs(R.wa_rate_paise).toFixed(2)}`],
    ['SMS sign-in code', `₹${rs(R.sms_rate_paise).toFixed(2)}`], ['Change any of these', 'Admin → Configuration']].forEach(([k, v]) => r.addRow({ k, v }));

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Everything the email needs: this week, last week, the file. */
async function build(at = new Date()) {
  const week = lastWeek(at);
  const before = { from: new Date(week.from.getTime() - 7 * 86400e3), to: week.from };
  const [cur, prev] = await Promise.all([figures(week.from, week.to), figures(before.from, before.to)]);
  const xlsx = await workbook(cur, prev, week);
  return { week, cur: cur.t, prev: prev.t, rates: cur.R, xlsx,
    filename: `GaadiPe-Weekly-Money-${day(week.from)}-to-${day(week.to.getTime() - 1)}.xlsx`,
    label: `${label(week.from)} – ${label(week.to.getTime() - 1)}` };
}

module.exports = { build, lastWeek, figures };
