/**
 * scripts/resend-summary.js — EMAIL A DAY'S SUMMARY AGAIN (user, 2026-10-16: "give me a script to
 * send me the mail of yesterday's summary"). The same email as the 11:55 pm one, built for a whole
 * past day (IST) against the day before, to the admin addresses (admin_alert_emails / ADMINMAIL).
 * Nothing goes to any customer.
 *
 *   node scripts/resend-summary.js                yesterday
 *   node scripts/resend-summary.js 2026-10-15     that day
 *   add --dry to print the figures without sending
 */
require('dotenv').config();
const mailer = require('../src/mail/mailer');
const notify = require('../src/jobs/notify');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const given = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const yesterday = new Date(Date.now() + 5.5 * 3600e3 - 86400e3).toISOString().slice(0, 10);
const day = given || yesterday;

(async () => {
  const mail = await notify.buildDailySummary(day);
  console.log(`Summary for ${day}: ${mail.subject}`);
  if (dry) { console.log(mail.text ? mail.text.slice(0, 1500) : '(built — HTML only)'); process.exit(0); }
  if (!mailer.configured()) { console.log('Mail is not configured on this machine (SMTP settings).'); process.exit(1); }
  const out = await mailer.send(mail);
  console.log(out.ok ? `Sent ✓ to ${out.to}` : `Not sent: ${out.error}`);
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
