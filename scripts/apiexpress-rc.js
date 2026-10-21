/**
 * scripts/apiexpress-rc.js — TRY API EXPRESS'S RC VERIFICATION (user, 2026-10-21: "give me a script
 * to call it, I will provide the key"). A possible cheaper source for private-vehicle RC than IDSPay.
 *
 * One call, printed in full so the fields can be compared with what GaadiPe needs (maker/model,
 * insurance / PUC / tax / fitness dates, owner count, financer, blacklist). Nothing is stored and
 * nothing is sent to anyone. It may be a paid call — run it only when you mean to.
 *
 * The key comes from .env, never the command line or the chat:
 *   APIEXPRESS_KEY=...
 *
 *   node scripts/apiexpress-rc.js KA02EX1480
 */
require('dotenv').config();

const reg = String(process.argv[2] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const key = String(process.env.APIEXPRESS_KEY || '').trim();

(async () => {
  if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(reg)) {
    console.log('usage: node scripts/apiexpress-rc.js KA02EX1480');
    process.exit(1);
  }
  if (!key) {
    console.log('❌ Add APIEXPRESS_KEY=... to .env first.');
    process.exit(1);
  }
  console.log(`\n${reg} — API Express RC verification\n`);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch('https://api.apiexpress.in/v1/rc/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rc_number: reg }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    console.log(`❌ ${e.name === 'TimeoutError' ? 'No answer in 30 s' : e.message}`);
    process.exit(1);
  }
  const ms = Date.now() - t0;
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not JSON — printed as text below */ }
  console.log(`HTTP ${res.status} · ${ms} ms\n`);
  console.log(json ? JSON.stringify(json, null, 2) : raw.slice(0, 3000));

  // What GaadiPe would need from it, found or not.
  if (json) {
    const flat = {};
    const walk = (o, p = '') => {
      for (const [k, v] of Object.entries(o || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${p}${k}.`);
        else flat[`${p}${k}`] = v;
      }
    };
    walk(json);
    const want = { 'maker / model': /maker|model|vehicle$|manufacturer/i, insurance: /insurance/i, PUC: /pucc?|pollution/i,
      'road tax': /tax/i, fitness: /fitness|fit_up/i, permit: /permit/i, owners: /owner_?(count|serial|sr)|no_of_owner/i,
      financer: /financ|hypothec|lien/i, blacklist: /blacklist/i, 'registration date': /reg(istration)?_?date/i };
    console.log('\nWhat GaadiPe needs:');
    for (const [label, re] of Object.entries(want)) {
      const hits = Object.entries(flat).filter(([k]) => re.test(k));
      console.log(`  ${hits.length ? '✅' : '❌'} ${label.padEnd(18)} ${hits.map(([k, v]) => `${k}=${v}`).join(' · ') || 'not in the answer'}`);
    }
  }
  process.exit(res.ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
