#!/usr/bin/env node
/**
 * scripts/invoices-month.js — ONE MONTH'S TAX INVOICES, FOR THE ACCOUNTANT (2026-10-12).
 *
 *   node scripts/invoices-month.js 2026-09            -> ~/invoices-2026-09/gaadipe/
 *   node scripts/invoices-month.js 2026-09 /some/dir  -> /some/dir/
 *
 * Copies every GaadiPe tax invoice dated in that month (IST) into one folder, with
 * invoices.csv (number, date, buyer, place of supply, taxable, CGST, SGST, IGST, total).
 * The owner's TEST- invoices are left out — they are not in the statutory series.
 * An invoice whose PDF is missing on disk is rebuilt from its stored row
 * (pay/invoice.js renderStored — the same function that made it), into the folder only.
 * READ-ONLY for the database.
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/db');
const { renderStored } = require('../src/pay/invoice');

const month = String(process.argv[2] || '');
if (!/^\d{4}-\d{2}$/.test(month)) { console.error('Usage: node scripts/invoices-month.js YYYY-MM [folder]'); process.exit(1); }
const out = process.argv[3] || path.join(os.homedir(), `invoices-${month}`, 'gaadipe');
const rupees = (p) => (Number(p || 0) / 100).toFixed(2);
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

(async () => {
  const { rows } = await db.query(
    // invoice_date is a DATE (already the Indian day) — compared and printed as text, no time zone.
    `SELECT *, to_char(invoice_date, 'YYYY-MM-DD') AS inv_day FROM invoices
      WHERE to_char(invoice_date, 'YYYY-MM') = $1
        AND invoice_number NOT LIKE 'TEST-%'
      ORDER BY invoice_date, invoice_number`, [month]);
  fs.mkdirSync(out, { recursive: true });
  const lines = ['invoice_number,invoice_date,buyer,place_of_supply,taxable,cgst,sgst,igst,total,pdf'];
  let copied = 0; let rebuilt = 0; let failed = 0;
  for (const r of rows) {
    const dest = path.join(out, `${r.invoice_number}.pdf`);
    let how = 'copied';
    try {
      if (r.pdf_path && fs.existsSync(r.pdf_path)) { fs.copyFileSync(r.pdf_path, dest); copied++; }
      else { fs.writeFileSync(dest, await renderStored(r)); rebuilt++; how = 'rebuilt'; }
    } catch (e) { failed++; how = `FAILED: ${e.message}`; }
    lines.push([r.invoice_number, r.inv_day, r.buyer_name, r.place_of_supply,
      rupees(r.base_paise), rupees(r.cgst_paise), rupees(r.sgst_paise), rupees(r.igst_paise), rupees(r.total_paise), how].map(csv).join(','));
  }
  fs.writeFileSync(path.join(out, 'invoices.csv'), `${lines.join('\n')}\n`);
  const sum = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  console.log(`GaadiPe ${month}: ${rows.length} invoice(s) · copied ${copied} · rebuilt ${rebuilt} · failed ${failed}`);
  console.log(`Taxable ₹${rupees(sum('base_paise'))} · CGST ₹${rupees(sum('cgst_paise'))} · SGST ₹${rupees(sum('sgst_paise'))} · IGST ₹${rupees(sum('igst_paise'))} · Total ₹${rupees(sum('total_paise'))}`);
  console.log(`Folder: ${out}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
