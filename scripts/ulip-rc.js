/**
 * scripts/ulip-rc.js — DOES ULIP ANSWER THIS VEHICLE'S RC? (user, 2026-10-21: "I want to check one
 * yellow board whether ULIP works, give me a script for KA13A1928"). ULIP's VAHAN answers commercial
 * (yellow-plate) vehicles only, so this is the test that it still does.
 *
 * RUN ON THE SERVER ONLY — ULIP allows the server's IP alone, and repeated failed logins lock the
 * account. One RC lookup, fresh, ULIP ALONE: no eChallan.app, no IDSPay (nothing paid), no challans,
 * no FASTag, nothing sent to anyone.
 *
 *   node scripts/ulip-rc.js KA13A1928
 */
require('dotenv').config();
const gateway = require('../src/vehicle/gateway');

const reg = String(process.argv[2] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const day = (d) => (d ? String(d).slice(0, 10) : '—');

(async () => {
  if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(reg)) {
    console.log('usage: node scripts/ulip-rc.js KA13A1928');
    process.exit(1);
  }
  console.log(`\n${reg} — RC fresh from ULIP alone (no eChallan.app, no IDSPay)\n`);
  const r = await gateway.rc(reg, { refresh: 1, backup: 0, ulip_only: 1 }).catch((e) => ({ success: false, message: e.message }));

  for (const c of r?.calls || []) console.log(`  call ${String(c.path).padEnd(12)} ${String(c.outcome || '').padEnd(10)} ${c.code || ''} ${c.ms != null ? `${c.ms} ms` : ''}`);
  if (!r?.success) {
    console.log(`\n❌ ULIP did not give the RC: ${r?.error || ''} ${r?.message || 'no answer'}`);
    process.exit(1);
  }
  const d = r.rc || {};
  console.log(`\n✅ ULIP answered (source ${r.source || 'ULIP'}${r.cached ? `, cached ${r.age_minutes} min` : ', fresh'})`);
  const rows = [
    ['Maker / model', [d.maker, d.model].filter(Boolean).join(' ') || '—'],
    ['Class', d.vehicle_class || d.class || '—'],
    ['Fuel', d.fuel_type || d.fuel || '—'],
    ['Registered', day(d.registration_date || d.reg_date)],
    ['RTO', d.rto || d.registering_authority || '—'],
    ['Insurance until', day(d.insurance_upto)],
    ['PUC until', day(d.pucc_upto)],
    ['Tax until', day(d.tax_upto)],
    ['Fitness until', day(d.fitness_upto || d.fit_upto)],
    ['Permit until', day(d.permit_upto || d.permit_valid_upto)],
    ['Status', d.status || d.rc_status || '—'],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(16)} ${v}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
