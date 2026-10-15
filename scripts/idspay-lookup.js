/**
 * scripts/idspay-lookup.js — ONE VEHICLE FROM THE PAID RC BACKUP, IDSPay (user, 2026-10-15:
 * "give me one script for KA04MP2043 to get from IDSPay"). ONE paid call (rc_backup_cost_paise,
 * about ₹3), through the same code customers use (vehicle/rcBackup.js lookup): its switch
 * (rc_backup flag), daily limit and keys all apply, and the call is counted as usual.
 *
 *   node scripts/idspay-lookup.js KA04MP2043
 *
 * Prints the vehicle with personal details masked, as GaadiPe shows them: the owner's name
 * starred, chassis and engine with their last characters hidden. Nothing is saved.
 */
require('dotenv').config();
const plate = require('../src/util/plate');
const backup = require('../src/vehicle/rcBackup');
const { maskName } = require('../src/whatsapp/report');

const tail = (v) => { const s = String(v || ''); return s.length > 5 ? `${s.slice(0, -5)}*****` : (s ? '*****' : null); };

(async () => {
  const p = plate.parse(process.argv[2] || '');
  if (!p.ok) { console.log('Usage: node scripts/idspay-lookup.js <vehicle number>   e.g. KA04MP2043'); process.exit(1); }
  if (!(await backup.enabled())) {
    console.log('The IDSPay backup is OFF or not configured (rc_backup flag, or API_ID / API_KEY / TOKEN_ID in .env). Nothing was called.');
    process.exit(1);
  }
  console.log(`Asking IDSPay for ${p.regNo} — one paid call…`);
  const out = await backup.lookup(p.regNo);
  if (!out) { console.log('Not called: the daily limit is reached or the backup is paused.'); process.exit(1); }
  if (out.outcome !== 'FOUND') {
    console.log(`${out.outcome === 'NOT_FOUND' ? 'No record' : 'Failed'}: ${out.code || ''} ${out.message || ''} (${out.ms} ms)`);
    process.exit(out.outcome === 'NOT_FOUND' ? 0 : 1);
  }
  const d = out.data;
  const rows = [
    ['Vehicle', [d.maker, d.model].filter(Boolean).join(' · ')],
    ['Fuel · class', [d.fuel, d.vehicle_class].filter(Boolean).join(' · ')],
    ['Registered', [d.reg_date, d.registered_at].filter(Boolean).join(' · ')],
    ['Owner (masked)', d.owner_name ? maskName(d.owner_name) : null],
    ['Owner no.', d.owner_serial],
    ['RC status', d.status],
    ['Insurance upto', d.insurance_upto], ['Insurer', d.insurance_company],
    ['PUC upto', d.pucc_upto], ['Tax upto', d.tax_upto], ['Fitness upto', d.fitness_upto],
    ['Permit upto', d.permit_upto], ['Registration upto', d.reg_upto],
    ['Loan / financer', d.financer || 'none on record'],
    ['Blacklist', d.blacklist_status || 'none on record'],
    ['Chassis (masked)', tail(d.chassis)], ['Engine (masked)', tail(d.engine)],
    ['Norms · seats · weight', [d.norms, d.seats && `${d.seats} seats`, d.unladen_weight && `${d.unladen_weight} kg`].filter(Boolean).join(' · ')],
  ].filter(([, v]) => v != null && v !== '');
  console.log(`\n${p.regNo} — IDSPay, ${out.ms} ms\n`);
  for (const [k, v] of rows) console.log(`  ${k.padEnd(24)} ${v}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
