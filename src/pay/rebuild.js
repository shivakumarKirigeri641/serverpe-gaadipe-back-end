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
const { renderStored } = require('./invoice');
const { buildVehicleReport, LAYOUT } = require('../pdf/vehicleReport');

const DIRS = {
  invoices: path.join(__dirname, '..', 'uploads', 'invoices'),
  vehicle_reports: path.join(__dirname, '..', 'uploads', 'reports'),
};

/**
 * An invoice PDF from its stored row, exactly as issued: the same function the
 * issue itself renders with (pay/invoice.js renderStored), reading the amounts
 * stored on the row and the vehicle, dates and payment ids from its payment.
 * `one` runs a one-row query — the app's database unless a script passes its own.
 */
function renderInvoice(inv, business, one) {
  // A fleet's invoice has no customer payment behind it (src/fleet).
  if (inv.fleet_payment_id && !one) return require('../fleet/fleets').renderFleetInvoice(inv, null, null, business);
  return renderStored(inv, { business, ...(one ? { one } : {}) });
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
 *
 * A REPORT PRINTED WITH AN OLDER LAYOUT is rebuilt too (user, 2026-10-02:
 * "make it older also") — from its own snapshot, so the same data, dates and
 * number, only shown as reports are shown now (personal details masked). No
 * vehicle lookup is made.
 */
async function ensureFile(table, id) {
  if (!DIRS[table]) throw new Error(`no documents in ${table}`);
  const row = await db.one(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  if (!row) return null;
  const stale = table === 'vehicle_reports' && Number(row.pdf_layout || 0) < LAYOUT;
  if (row.pdf_path && fs.existsSync(row.pdf_path) && !stale) return row.pdf_path;

  const business = await db.one(
    `SELECT * FROM business_details WHERE is_active ORDER BY id DESC LIMIT 1`) || {};
  const pdf = table === 'invoices' ? await renderInvoice(row, business) : await renderReport(row, business);

  fs.mkdirSync(DIRS[table], { recursive: true });
  const file = path.join(DIRS[table], `${row[NUMBER[table]]}.pdf`);
  fs.writeFileSync(file, pdf);
  await db.query(table === 'vehicle_reports'
    ? `UPDATE vehicle_reports SET pdf_path = $2, pdf_layout = ${LAYOUT} WHERE id = $1`
    : `UPDATE ${table} SET pdf_path = $2 WHERE id = $1`, [row.id, file]);
  console.log('[rebuild] %s %s %s — rebuilt from its row (%d bytes)', table, row[NUMBER[table]],
    stale && row.pdf_path && fs.existsSync(row.pdf_path) ? `was layout ${row.pdf_layout || 1}` : 'was missing', pdf.length);
  return file;
}

module.exports = { ensureFile, renderInvoice, renderReport };
