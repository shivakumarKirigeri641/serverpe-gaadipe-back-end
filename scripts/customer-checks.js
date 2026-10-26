/**
 * scripts/customer-checks.js — ONE CUSTOMER'S VEHICLE CHECKS (user, 2026-10-27: "check this number, he is asking for one
 * vehicle number - if his free trial is exhausted, I will reply that free is exhausted"). Read-only; sends nothing.
 *
 *   node scripts/customer-checks.js 9327336521
 *
 * Shows: who they are, whether the free check is used, check-pack credits left, every vehicle they checked, what
 * they paid, and their last WhatsApp messages - so you can answer them by hand.
 */
require('dotenv').config();
const db = require('../src/db');
const quota = require('../src/util/quota');

const mobile = String(process.argv[2] || '').replace(/\D/g, '').slice(-10);
if (mobile.length !== 10) { console.error('Usage: node scripts/customer-checks.js <10-digit mobile>'); process.exit(1); }

const ist = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '-');

(async () => {
  const u = await db.one(
    `SELECT id, mobile, coalesce(display_name, wa_profile_name) AS name, created_at
       FROM users WHERE right(mobile, 10) = $1 ORDER BY id LIMIT 1`, [mobile]).catch(() => null);
  if (!u) { console.log(`\nNo customer with mobile ${mobile}.\n`); process.exit(0); }

  const tier = await quota.tierOf(u.id);
  const left = await quota.left(u.id);
  console.log(`\n${u.name || '(no name)'} · ${u.mobile} · customer #${u.id} · joined ${ist(u.created_at)} · ${tier}`);

  if (left.unlimited) console.log('  Unlimited checks (internal or partner).');
  else if (left.packs) {
    console.log(`  Free check:     ${left.free_left > 0 ? 'NOT used yet - 1 free check left' : 'USED (free trial over)'}`);
    console.log(`  Pack checks:    ${left.credits.left} left${left.credits.left ? ` (soonest expiry ${ist(left.credits.expires)})` : ''}`);
    console.log(`  Can check a NEW vehicle now: ${left.today.left > 0 ? 'YES' : 'NO - needs a pack (₹25 / ₹49 / ₹99)'}`);
  } else console.log(`  Today ${left.today.used}/${left.today.limit}${left.month ? ` · month ${left.month.used}/${left.month.limit}` : ''}`);

  const { rows: checks } = await db.query(
    `SELECT created_at, kind, detail->>'reg_no' AS reg, detail->>'found' AS found, detail->>'credit' AS credit,
            detail->>'channel' AS channel
       FROM event_log WHERE user_id = $1 AND kind IN ('vehicle_check', 'vehicle_check_repeat', 'checks_out')
      ORDER BY created_at`, [u.id]);
  console.log(`\nVehicle checks (${checks.filter((c) => c.kind === 'vehicle_check').length} new, repeats free):`);
  if (!checks.length) console.log('  none');
  for (const c of checks) {
    const what = c.kind === 'checks_out' ? 'shown the packs (no checks left)'
      : `${c.reg}${c.found === 'false' ? ' · not found' : ''}${c.kind === 'vehicle_check_repeat' ? ' · repeat (free)' : c.credit ? ' · pack check' : ''}`;
    console.log(`  ${ist(c.created_at)}  ${what}${c.channel ? ` · ${c.channel}` : ''}`);
  }

  const { rows: pays } = await db.query(
    `SELECT p.paid_at, p.amount_paise, pl.code, pl.kind FROM payments p JOIN plans pl ON pl.id = p.plan_id
      WHERE p.user_id = $1 AND p.status = 'paid' ORDER BY p.paid_at`, [u.id]);
  console.log(`\nPaid: ${pays.length ? '' : 'nothing'}`);
  for (const p of pays) console.log(`  ${ist(p.paid_at)}  ₹${(p.amount_paise / 100).toFixed(0)} · ${p.code} (${p.kind})`);

  const { rows: msgs } = await db.query(
    `SELECT created_at, direction, left(regexp_replace(coalesce(body, ''), '\\s+', ' ', 'g'), 90) AS body
       FROM whatsapp_messages WHERE right(mobile, 10) = $1 ORDER BY created_at DESC LIMIT 8`, [mobile]).catch(() => ({ rows: [] }));
  console.log('\nLast WhatsApp messages (newest first):');
  if (!msgs.length) console.log('  none');
  for (const m of msgs) console.log(`  ${ist(m.created_at)}  ${m.direction === 'in' ? 'THEM' : 'US  '}  ${m.body}`);
  console.log('');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
