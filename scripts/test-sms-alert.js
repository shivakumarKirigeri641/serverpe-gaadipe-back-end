/**
 * scripts/test-sms-alert.js — SEND ONE ALERT SMS TO YOUR OWN NUMBER (user, 2026-10-22: "SMS templates
 * approved"). Before sms_alerts_enabled is switched on for every customer, see each approved alert
 * template exactly as a customer would get it.
 *
 *   node scripts/test-sms-alert.js 9886122415 expiry        one kind: expiry | challan | status | monitor_end
 *   node scripts/test-sms-alert.js 9886122415 all           all four, one after another
 *   add --dry to print what would go and send nothing
 *
 * ONLY to GaadiPe's own internal numbers (users.is_internal) — any other number is refused. Goes through
 * the same door as a real alert (util/sms.sendTemplate): the template id from Settings (sms_tpl_<kind>),
 * the value clean-up and 30-character cut. Works while sms_alerts_enabled is still off. Logged like any SMS.
 */
require('dotenv').config();
const db = require('../src/db');
const settings = require('../src/util/settings');
const sms = require('../src/util/sms');

// Sample values, in the order each template's {#var#} expects (util/sms.js).
const SAMPLE = {
  expiry: ['Insurance', 'KA01AB1234', '29 Oct 2026'],
  challan: ['KA01AB1234', '1 pending Rs 500'],
  status: ['KA01AB1234', 'PUC expired'],
  monitor_end: ['KA01AB1234', '30 Oct 2026'],
};

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const [rawMobile, which = 'all'] = args.filter((a) => !a.startsWith('--'));
const mobile = String(rawMobile || '').replace(/\D/g, '').slice(-10);

(async () => {
  const kinds = which === 'all' ? Object.keys(SAMPLE) : [which];
  if (mobile.length !== 10 || kinds.some((k) => !SAMPLE[k])) {
    console.log('usage: node scripts/test-sms-alert.js 9886122415 [expiry|challan|status|monitor_end|all] [--dry]');
    process.exit(1);
  }
  const own = await db.one(
    `SELECT 1 FROM users WHERE right(regexp_replace(mobile, '[^0-9]', '', 'g'), 10) = $1 AND is_internal LIMIT 1`, [mobile]).catch(() => null);
  if (!own) {
    console.log(`Refused: ${mobile} is not one of GaadiPe's own (internal) numbers. Tests go only to your own number.`);
    process.exit(1);
  }
  console.log(`\nSMS alerts master switch: ${await settings.bool('sms_alerts_enabled', false) ? 'ON' : 'off (a test to your own number still goes)'}\n`);
  for (const kind of kinds) {
    const id = String(await settings.get(`sms_tpl_${kind}`, '') || '').trim();
    const line = `${kind.padEnd(12)} template ${id || '(not set)'}  values: ${SAMPLE[kind].join(' | ')}`;
    if (!id) { console.log(`${line}\n  -> skipped: set sms_tpl_${kind} in Configuration first\n`); continue; }
    if (dry) { console.log(`${line}\n  -> dry run, nothing sent\n`); continue; }
    const out = await sms.sendTemplate(kind, mobile, SAMPLE[kind], { test: true });
    console.log(`${line}\n  -> ${out.ok ? `sent${out.simulated ? ' (simulated: no SMS provider set)' : ''}` : `NOT sent: ${out.error}`}\n`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
