/**
 * scripts/way2api-test.js — ONE WAY2API CALL THROUGH GAADIPE'S OWN CODE (user, 2026-10-21: "give me a
 * script to test once"). Proves the key, the auth header and the reading of the answer before customers
 * depend on it. Asks Way2API directly (no ULIP, no eChallan.app, no IDSPay).
 *
 * ONE PAID CALL (~$0.0254): the call is counted in today's limit and taken off way2api_balance_usd, like
 * any other. The vehicle is NOT saved, and nothing is sent to anyone.
 *
 *   node scripts/way2api-test.js KA31N8147
 */
require('dotenv').config();
const w = require('../src/vehicle/way2api');

const reg = String(process.argv[2] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

(async () => {
  if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(reg)) {
    console.log('usage: node scripts/way2api-test.js KA31N8147');
    process.exit(1);
  }
  console.log('\nWAY2API — one test call');
  console.log('  key in .env (WAYTWOAPI_KEY)  ', w.configured() ? 'yes' : '❌ missing — add it to .env');
  console.log('  auth header                  ', process.env.WAYTWOAPI_AUTH_HEADER ? process.env.WAYTWOAPI_AUTH_HEADER : 'Authorization: Bearer <key>');
  console.log('  switched on (way2api_enabled)', await w.enabled() ? 'yes' : '❌ no');
  const t = await w.today();
  console.log('  calls today                  ', `${t.used} of ${t.limit}`);
  const before = await w.balance();
  console.log('  balance before               ', before === null ? 'not tracked — set way2api_balance_usd in Settings' : `$${before}`);
  if (!w.configured()) process.exit(1);

  console.log(`\n${reg} …`);
  const r = await w.lookup(reg);
  if (!r) { console.log('❌ Not asked: switched off, daily limit reached, or the wallet is below one call.'); process.exit(1); }
  console.log(`  outcome ${r.outcome}${r.code ? ` · code ${r.code}` : ''}${r.message ? ` · ${r.message}` : ''} · ${r.ms} ms`);
  if (r.outcome === 'FOUND') {
    const d = r.data;
    const rows = [
      ['Maker / model', [d.maker, d.model].filter(Boolean).join(' ')],
      ['Registered', `${d.reg_date || '—'} · ${d.registered_at || '—'}`],
      ['Owners', d.owner_serial], ['Financer', d.financer || 'none'],
      ['Insurance until', d.insurance_upto], ['PUC until', d.pucc_upto || 'not on record'],
      ['Tax until', d.tax_upto], ['Fitness / RC until', d.fitness_upto], ['RC status', d.status],
    ];
    for (const [k, v] of rows) console.log(`  ${k.padEnd(18)} ${v ?? '—'}`);
    console.log('\n✅ Way2API works. Customers now get it after ULIP and eChallan.app, before IDSPay.');
  } else if (r.outcome === 'NOT_FOUND') {
    console.log('\n⚠️ Way2API answered "not found" — the key and header work; try a number you know exists.');
  } else if (/401|403|unauthori|forbidden|invalid/i.test(`${r.code} ${r.message}`)) {
    console.log('\n❌ Key or header refused. Check WAYTWOAPI_KEY, or set WAYTWOAPI_AUTH_HEADER (e.g. x-api-key) as Way2API\'s docs say, then run again.');
  } else {
    console.log('\n❌ No vehicle — see the outcome above.');
  }
  console.log(`  balance after                 ${(await w.balance()) ?? 'not tracked'}`);
  process.exit(r.outcome === 'FOUND' ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
