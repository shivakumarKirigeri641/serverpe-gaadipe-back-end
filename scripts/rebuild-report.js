/**
 * scripts/rebuild-report.js
 * ---------------------------------------------------------------------------
 * Rebuild a vehicle report PDF from its database row.
 *
 *   node scripts/rebuild-report.js <REPORT_NUMBER>
 *   node scripts/rebuild-report.js <REPORT_NUMBER> --db serverpe_gaadipe
 *   node scripts/rebuild-report.js <REPORT_NUMBER> --out /tmp
 *
 * The companion of rebuild-invoice.js. A report is its row — the snapshot of
 * exactly what was reported, who asked, and the consent they gave — and the
 * PDF is a rendering of it (src/pay/report.js). So a lost file is rebuilt
 * identically from that snapshot, never from today's vehicle data, which would
 * put a different document under the same number.
 *
 * Reads only. Writes the PDF file and nothing in the database; if the row is
 * not there, it stops.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { renderReport } = require('../src/pay/rebuild');

const args = process.argv.slice(2);
const number = args.find(a => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

if (!number) {
  console.log('usage: node scripts/rebuild-report.js <REPORT_NUMBER> [--db name] [--out dir]');
  process.exit(1);
}

const database = flag('db', process.env.PGDATABASE);
const outDir = flag('out', path.join(__dirname, '..', 'src', 'uploads', 'reports'));

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

  const report = (await c.query('SELECT * FROM vehicle_reports WHERE report_number = $1', [number])).rows[0];
  if (!report) {
    console.error(`\n  no report numbered ${number} in ${database}. Nothing regenerated.\n`);
    await c.end();
    process.exit(1);
  }

  const business = (await c.query(
    `SELECT * FROM business_details WHERE is_active ORDER BY id DESC LIMIT 1`)).rows[0] || {};

  console.log(`  ${report.reg_no}  for ${report.requester_name || '-'} ${report.requested_by || ''}`);
  console.log(`  issued ${new Date(report.created_at).toString()}  via ${report.channel}`);

  // The same rendering the admin panel and the website use (src/pay/rebuild.js).
  const pdf = await renderReport(report, business);

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${number}.pdf`);
  fs.writeFileSync(file, pdf);
  console.log(`\n  written: ${file}  (${pdf.length} bytes)\n`);

  await c.end();
})().catch((e) => {
  console.error('\nfailed:', e.message, '\n');
  process.exit(1);
});
