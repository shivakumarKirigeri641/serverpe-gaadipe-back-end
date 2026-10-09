/**
 * scripts/launch-update.js — WhatsApp is back (user, 2026-10-09): send today's
 * monitoring status ONCE to every paying customer with monitoring on, one
 * customer every 5 seconds.
 *
 *   node scripts/launch-update.js            dry run: who would get it, nothing sent
 *   node scripts/launch-update.js --send     send, 5 s apart
 *   node scripts/launch-update.js --send --gap 10   another gap, in seconds
 *
 * The rules are jobs/watch.js dailyStatus's: paid for that vehicle, agreed to the
 * Terms, never STOP or "Alert only on change", and nobody twice (running it again
 * sends nothing to anyone already done). Inside a customer's 24-hour window it
 * goes as a free message, otherwise as the approved monitoring template.
 *
 * STOPS AT ONCE if WhatsApp says no: sending switched off, the brake's template
 * pause (Meta's spam limit), or Meta's account-locked / spam-limit errors.
 */
require('dotenv').config();
const watch = require('../src/jobs/watch');

const args = process.argv.slice(2);
const live = args.includes('--send');
const gapAt = args.indexOf('--gap');
const gapSec = gapAt >= 0 ? Math.max(1, Number(args[gapAt + 1]) || 5) : 5;
const STOP_ON = /whatsapp_off|templates_paused|recipient_not_allowed|^131048|^131031|^190\b/;

(async () => {
  if (!live) {
    const r = await watch.dailyStatus({ everyone: true, dryRun: true });
    console.log(`DRY RUN — nothing sent. ${r.people} customer(s) would get it:\n`);
    for (const p of r.would) console.log(`  ${p.mobile}  ${(p.name || '').padEnd(18)} ${p.vehicles.join(', ').padEnd(30)} → ${p.goes_as}`);
    console.log(`\nTo send, 5 s apart (about ${Math.ceil((r.people * gapSec) / 60)} min):  node scripts/launch-update.js --send`);
    process.exit(0);
  }

  console.log(`Sending, one customer every ${gapSec} s. Ctrl+C stops it; those already sent are not sent again.\n`);
  let ok = 0; let failed = 0; let stoppedFor = null;
  const r = await watch.dailyStatus({
    everyone: true,
    gapMs: gapSec * 1000,
    onEach: ({ n, of, mobile, vehicles, out }) => {
      const t = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
      if (out?.ok) ok += 1; else failed += 1;
      console.log(`  ${t}  ${n}/${of}  ••${String(mobile).slice(-4)}  ${vehicles.join(', ')}  ${out?.ok ? '✅ sent' : `❌ ${out?.error}`}`);
      if (!out?.ok && STOP_ON.test(String(out?.error || ''))) { stoppedFor = out.error; return false; }
      return true;
    },
  });
  console.log(`\nDone: ${ok} sent, ${failed} not sent.${stoppedFor ? `  STOPPED EARLY: ${stoppedFor}` : ''}`);
  if (r.sent !== ok) console.log(`(job counted ${r.sent})`);
  process.exit(stoppedFor ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
