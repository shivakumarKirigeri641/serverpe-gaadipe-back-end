#!/usr/bin/env node
/**
 * scripts/finance-weekly.js — the weekly money report, by hand.
 *
 *   node scripts/finance-weekly.js            write the Excel for the week just ended to ./
 *   node scripts/finance-weekly.js --send     email it now to finance_report_emails
 *
 * The Saturday email is automatic (jobs/notify.js); this is for a test, or a
 * week that needs sending again.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

(async () => {
  if (process.argv.includes('--send')) {
    const n = await require('../src/jobs/notify').weeklyMoney({ force: true });
    console.log(n ? 'Sent.' : 'Not sent — check the mail settings (MAIL_HOST, NOREPLYMAIL) and finance_report_emails.');
  } else {
    const r = await require('../src/finance/weekly').build();
    const file = path.resolve(r.filename);
    fs.writeFileSync(file, r.xlsx);
    console.log(`Week ${r.label}: gross ₹${(r.cur.gross / 100).toFixed(2)}, net ₹${(r.cur.net / 100).toFixed(2)}`);
    console.log(`Written: ${file}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
