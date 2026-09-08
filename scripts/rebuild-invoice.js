/**
 * scripts/rebuild-invoice.js
 * ---------------------------------------------------------------------------
 * Rebuild an invoice PDF from its database row.
 *
 *   node scripts/rebuild-invoice.js INV20260818GP1
 *   node scripts/rebuild-invoice.js INV20260818GP1 --db serverpe_verifyvahan
 *   node scripts/rebuild-invoice.js INV20260818GP1 --out /tmp
 *
 * A GST invoice PDF is a rendering of data, not the record itself — the record
 * is the row. So a lost or deleted file is recoverable exactly, with the same
 * invoice number, as long as the row survives. That is worth knowing before
 * anyone panics about a missing file.
 *
 * Reads whichever database is given (the old one still holds pre-migration
 * invoices), and never invents a number: if the row is not there, it stops.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { buildInvoice } = require('../src/pdf/invoice');

const args = process.argv.slice(2);
const number = args.find(a => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

if (!number) {
  console.log('usage: node scripts/rebuild-invoice.js <INVOICE_NUMBER> [--db name] [--out dir]');
  process.exit(1);
}

const database = flag('db', process.env.PGDATABASE);
const outDir = flag('out', path.join(__dirname, '..', 'src', 'uploads', 'invoices'));

(async () => {
  const c = new Client({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database,
  });
  await c.connect();
  console.log(`\nreading ${number} from ${database}`);

  const inv = (await c.query('SELECT * FROM invoices WHERE invoice_number = $1', [number])).rows[0];
  if (!inv) {
    console.error(`\n  no invoice numbered ${number} in ${database}. Nothing regenerated.\n`);
    await c.end();
    process.exit(1);
  }

  // Seller details as they were — an invoice must show the business as it was
  // registered at the time, not as it is today.
  const business = (await c.query(
    `SELECT * FROM business_details WHERE is_active ORDER BY id DESC LIMIT 1`)).rows[0] || {};

  const gross = Number(inv.gross_amount ?? inv.total_paise / 100 ?? 0);
  const taxable = Number(inv.taxable_amount ?? 0) || null;

  console.log(`  ${inv.customer_name}  ${inv.customer_mobile}`);
  console.log(`  gross ₹${gross.toFixed(2)}  tax ₹${Number(inv.total_tax || 0).toFixed(2)}  ${new Date(inv.invoice_date).toDateString()}`);

  const pdf = await buildInvoice({
    invoice: inv,
    business,
    gst: {
      taxable_amount: taxable,
      cgst_amount: Number(inv.cgst_amount || 0),
      sgst_amount: Number(inv.sgst_amount || 0),
      igst_amount: Number(inv.igst_amount || 0),
      total_tax: Number(inv.total_tax || 0),
      is_interstate: !!inv.is_interstate,
      sac_code: inv.sac_code,
    },
    lineItem: {
      description: inv.description || 'GaadiPe vehicle report and monitoring',
      amount: gross,
    },
  });

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${number}.pdf`);
  fs.writeFileSync(file, pdf);
  console.log(`\n  written: ${file}  (${pdf.length} bytes)\n`);

  await c.end();
})().catch((e) => {
  console.error('\nfailed:', e.message, '\n');
  process.exit(1);
});
