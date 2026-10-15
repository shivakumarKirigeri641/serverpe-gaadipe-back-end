/**
 * scripts/echallan-lookup.js — ONE VEHICLE FROM eCHALLAN.APP (user, 2026-10-15: "IDSPay RC fetch
 * working, let me check eChallan.app — can you give a script"). Through the same code customers
 * use (vehicle/echallanApp.js): the account (key status and credits), the RC, and the challans.
 * eChallan.app is the free second source today (credits sponsored); each call may use a credit.
 *
 *   node scripts/echallan-lookup.js KA04MP2043            account + RC + challans
 *   node scripts/echallan-lookup.js KA04MP2043 --rc       account + RC only
 *   node scripts/echallan-lookup.js KA04MP2043 --challans account + challans only
 *
 * Personal details are printed masked, as GaadiPe shows them. Nothing is saved.
 */
require('dotenv').config();
const plate = require('../src/util/plate');
const app = require('../src/vehicle/echallanApp');
const { maskName } = require('../src/whatsapp/report');

const args = process.argv.slice(2);
const onlyRc = args.includes('--rc');
const onlyChallans = args.includes('--challans');
const tail = (v) => { const s = String(v || ''); return s.length > 5 ? `${s.slice(0, -5)}*****` : (s ? '*****' : null); };
const rs = (p) => `₹${Math.round(Number(p || 0) / 100).toLocaleString('en-IN')}`;

(async () => {
  const p = plate.parse(args.find((a) => !a.startsWith('--')) || '');
  if (!p.ok) { console.log('Usage: node scripts/echallan-lookup.js <vehicle number> [--rc | --challans]'); process.exit(1); }

  const acc = await app.account();
  if (!acc.configured) { console.log('eChallan.app is not configured (ECHALLANAPP_APIKEY in .env). Nothing was called.'); process.exit(1); }
  console.log('Account:', acc.error ? `error — ${acc.error}`
    : `${acc.status || '?'} · ${acc.environment || ''} · credits ${acc.api_credits ?? acc.credits ?? '?'} · used ${acc.used ?? '?'} of ${acc.limit ?? '?'}${acc.enabled ? '' : ' · (switched OFF in GaadiPe)'}`);
  if (!acc.enabled) { console.log('It is switched off in GaadiPe, so customers never reach it; the lookup below still runs.'); }

  if (!onlyChallans) {
    // rc() returns null while it is switched off in GaadiPe; say so rather than guess.
    const r = await app.rc(p.regNo);
    if (!r) console.log(`\nRC: not called (eChallan.app is switched off in GaadiPe).`);
    else if (r.outcome !== 'FOUND') console.log(`\nRC: ${r.outcome} ${r.code || ''} — ${r.message || ''} (${r.ms} ms)`);
    else {
      const d = r.data;
      const rows = [
        ['Vehicle', [d.maker, d.model].filter(Boolean).join(' · ')],
        ['Fuel · class', [d.fuel, d.vehicle_class].filter(Boolean).join(' · ')],
        ['Registered', [d.reg_date, d.registered_at].filter(Boolean).join(' · ')],
        ['Owner (masked)', d.owner_name ? maskName(d.owner_name) : null],
        ['Owner no.', d.owner_serial], ['RC status', d.status],
        ['Insurance upto', d.insurance_upto], ['PUC upto', d.pucc_upto], ['Tax upto', d.tax_upto],
        ['Fitness upto', d.fitness_upto], ['Loan / financer', d.financer || 'none on record'],
        ['Blacklist', d.blacklist_status || 'none on record'],
        ['Chassis (masked)', tail(d.chassis)], ['Engine (masked)', tail(d.engine)],
      ].filter(([, v]) => v != null && v !== '');
      console.log(`\nRC — ${p.regNo}, ${r.ms} ms`);
      for (const [k, v] of rows) console.log(`  ${k.padEnd(20)} ${v}`);
    }
  }

  if (!onlyRc) {
    const c = await app.challans(p.regNo);
    if (!c) console.log('\nChallans: not called (eChallan.app is switched off in GaadiPe).');
    else if (!c.ok) console.log(`\nChallans: failed ${c.code || ''} ${c.error || ''}`);
    else {
      const d = c.data;
      console.log(`\nChallans — ${d.pending_count} pending (${rs(d.pending_amount_paise)}), ${d.disposed_count} disposed, ${c.ms} ms`);
      for (const x of d.pending.slice(0, 15)) {
        console.log(`  • ${x.date || x.challan_date || ''}  ${rs(x.amount_paise)}  ${String(x.offence || x.offence_details || '').slice(0, 70)}  ${x.place ? `@ ${String(x.place).slice(0, 40)}` : ''}`);
      }
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
