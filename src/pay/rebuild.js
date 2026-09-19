/**
 * src/pay/rebuild.js
 * ---------------------------------------------------------------------------
 * A document's PDF, rebuilt from its row when the file is not on disk.
 *
 * The row is the record and the PDF a rendering of it (pay/invoice.js,
 * pay/report.js): an invoice from its stored amounts, a report from the
 * snapshot taken when it was issued — never today's vehicle data. So when a
 * file has gone (a redeploy, a re-clone, a disk moved) the same document comes
 * back under the same number, and whoever clicked View or Download simply gets
 * it (user, 2026-09-19).
 *
 * The two render functions take plain rows and do no database work, so the
 * command-line scripts (scripts/rebuild-invoice.js, rebuild-report.js), which
 * read other databases, use exactly the same rendering.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { buildInvoice } = require('../pdf/invoice');
const { buildVehicleReport } = require('../pdf/vehicleReport');

const DIRS = {
  invoices: path.join(__dirname, '..', 'uploads', 'invoices'),
  vehicle_reports: path.join(__dirname, '..', 'uploads', 'reports'),
};

/** An invoice PDF from its row and the seller's details. */
function renderInvoice(inv, business = {}) {
  const gross = Number(inv.gross_amount ?? inv.total_paise / 100 ?? 0);
  const taxable = Number(inv.taxable_amount ?? 0) || null;
  return buildInvoice({
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
}

/** A vehicle report PDF from its row: the snapshot, the requester and the consent. */
function renderReport(report, business = {}) {
  return buildVehicleReport({
    report,
    business,
    data: report.snapshot,
    consent: report.consent || null,
    requester: {
      name: report.requester_name, mobile: report.requested_by,
      ip: report.ip, device: report.device, channel: report.channel || 'whatsapp',
    },
  });
}

const NUMBER = { invoices: 'invoice_number', vehicle_reports: 'report_number' };

/**
 * The file for a row, rebuilt first if it is missing. Returns its path, or
 * null when there is no such row.
 */
async function ensureFile(table, id) {
  if (!DIRS[table]) throw new Error(`no documents in ${table}`);
  const row = await db.one(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  if (!row) return null;
  if (row.pdf_path && fs.existsSync(row.pdf_path)) return row.pdf_path;

  const business = await db.one(
    `SELECT * FROM business_details WHERE is_active ORDER BY id DESC LIMIT 1`) || {};
  const pdf = table === 'invoices' ? await renderInvoice(row, business) : await renderReport(row, business);

  fs.mkdirSync(DIRS[table], { recursive: true });
  const file = path.join(DIRS[table], `${row[NUMBER[table]]}.pdf`);
  fs.writeFileSync(file, pdf);
  await db.query(`UPDATE ${table} SET pdf_path = $2 WHERE id = $1`, [row.id, file]);
  console.log('[rebuild] %s %s was missing — rebuilt from its row (%d bytes)', table, row[NUMBER[table]], pdf.length);
  return file;
}

module.exports = { ensureFile, renderInvoice, renderReport };
