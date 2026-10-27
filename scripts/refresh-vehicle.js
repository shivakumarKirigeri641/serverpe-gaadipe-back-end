/**
 * scripts/refresh-vehicle.js — A CUSTOMER SAYS "I RENEWED, YOU STILL SHOW THE OLD DATE" (user, 2026-10-27: WB34AF6056,
 * "insurance already renewed but still showing old"). Shows the dates GaadiPe has saved and from when, makes ONE fresh
 * lookup (ULIP first - free, goods vehicles only - then the paid RC source, ~₹1.90-2.95), saves it, and prints
 * old → new for every date. Sends nothing to anyone.
 *
 *   node scripts/refresh-vehicle.js WB34AF6056            saved dates, then the fresh lookup (one paid call at most)
 *   node scripts/refresh-vehicle.js WB34AF6056 --dry      saved dates only - no lookup, nothing paid
 *
 * If the fresh record still shows the old date, the government record itself is not updated yet (the insurer's
 * update reaches VAHAN in days, sometimes weeks) - not a GaadiPe fault; see the note it prints.
 */
require('dotenv').config();
const db = require('../src/db');

const reg = String(process.argv[2] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const dry = process.argv.includes('--dry');
const FIELDS = [['insurance_upto', 'Insurance'], ['pucc_upto', 'PUC'], ['tax_upto', 'Road tax'], ['fitness_upto', 'Fitness'], ['permit_upto', 'Permit']];
const day = (d) => (d ? String(d).slice(0, 10) : '—');
const ist = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—');

(async () => {
  if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(reg)) { console.log('usage: node scripts/refresh-vehicle.js WB34AF6056 [--dry]'); process.exit(1); }
  const v = await db.one(`SELECT id, reg_no FROM vehicles WHERE reg_no = $1`, [reg]);
  if (!v) { console.log(`\n${reg} is not in GaadiPe's records yet.\n`); process.exit(0); }

  const snap = await db.one(
    `SELECT data, fetched_at, source FROM vehicle_snapshots WHERE vehicle_id = $1 AND dataset = 'rc'
      ORDER BY fetched_at DESC LIMIT 1`, [v.id]).catch(() => null);
  const old = snap?.data || {};
  console.log(`\n${reg} — saved record from ${ist(snap?.fetched_at)} (${snap?.source || 'source not noted'})`);
  for (const [k, label] of FIELDS) if (old[k]) console.log(`  ${label.padEnd(10)} ${day(old[k])}`);
  const who = await db.query(
    `SELECT DISTINCT right(u.mobile, 4) AS last4 FROM vehicle_reports r JOIN users u ON u.id = r.user_id
      WHERE r.reg_no = $1 AND r.valid_until > now()`, [reg]).then((r) => r.rows.map((x) => x.last4)).catch(() => []);
  console.log(`  Valid reports held by: ${who.length ? who.map((x) => `…${x}`).join(', ') : 'nobody'}`);
  if (dry) { console.log('\n--dry: no lookup made.\n'); process.exit(0); }

  console.log('\nFresh lookup (ULIP first, then the paid source if needed) …');
  const data = await require('../src/vehicle/gateway').full(reg, { refresh: 1 }).catch((e) => ({ success: false, error: e.message }));
  if (!data?.success || !data.rc) {
    console.log(`  No fresh record: ${data?.error || data?.message || 'no answer'}. Nothing changed.\n`);
    process.exit(0);
  }
  await require('../src/vehicle/store').record(null, data, { link: false });
  console.log(`  From: ${data.rc_source || data.source || 'the records'} — saved.\n`);
  let changed = false;
  for (const [k, label] of FIELDS) {
    const a = day(old[k]); const b = day(data.rc[k]);
    if (a === '—' && b === '—') continue;
    if (a !== b) changed = true;
    console.log(`  ${label.padEnd(10)} ${a}  →  ${b}${a !== b ? '   ← UPDATED' : ''}`);
  }
  console.log(changed
    ? '\n✅ The new dates are saved. The customer sees them on their next check or report; alerts use them from now.\n'
    : '\nℹ️  The government record still shows the same dates. The insurer has not updated VAHAN yet - this usually takes\n'
      + '   a few days, sometimes 2-3 weeks. Tell the customer their policy is valid regardless, and it will show here once\n'
      + '   VAHAN is updated. They can also ask the insurer to update VAHAN.\n');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
