/**
 * scripts/ulip-status.js — IS THE ULIP LOGIN WORKING, AND WHY NOT (user, 2026-10-15: "ULIP login is
 * not working, give a script to run"). Run ON THE SERVER only: ULIP allows the server's IP alone.
 *
 *   node scripts/ulip-status.js               read-only: no call to ULIP at all
 *   node scripts/ulip-status.js --try-login   plus ONE login attempt — only if logins are not paused
 *
 * ULIP locks an account after repeated failed logins, so this never loops and never logs in while
 * GaadiPe's own pause is running (src/ulip/client.js: 30 min after a refusal, doubling up to 6 h).
 * Prints no password or token.
 */
require('dotenv').config();
const db = require('../src/db');
const { config } = require('../src/config');

const ist = (ms) => new Date(Number(ms)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

(async () => {
  console.log('ULIP address   :', config.ulip.baseUrl);
  console.log('Username set   :', config.ulip.username ? `yes (${String(config.ulip.username).slice(0, 3)}…)` : 'NO — ULIP_USERNAME missing in .env');
  console.log('Password set   :', config.ulip.password ? 'yes' : 'NO — ULIP_PASSWORD missing in .env');
  const off = /^(1|true|yes|on)$/i.test(String(process.env.ULIP_LOGIN_OFF || ''));
  console.log('Logins off     :', off ? 'YES — ULIP_LOGIN_OFF is set in .env, nothing will log in' : 'no');

  const row = await db.one(`SELECT value, modified_at FROM app_settings WHERE key = 'ulip_login_paused_until'`).catch(() => null);
  let paused = false;
  if (row?.value) {
    const s = JSON.parse(row.value);
    paused = Number(s.until) > Date.now();
    console.log('Login pause    :', paused
      ? `PAUSED until ${ist(s.until)} (${Math.ceil((Number(s.until) - Date.now()) / 60000)} min more)`
      : `none now (last one ended ${s.until ? ist(s.until) : '—'})`);
    console.log('  last refusal :', s.why || '—', `· refusals in a row: ${s.refusals || 0}`);
  } else {
    console.log('Login pause    : never paused');
  }

  const { rows } = await db.query(
    `SELECT provider_path, outcome, error_code, count(*)::int AS n, max(created_at) AS last
       FROM api_calls
      WHERE NOT cache_hit AND created_at > now() - interval '3 hours'
        AND (provider_path LIKE 'VAHAN%' OR provider_path LIKE 'ECHALLAN/%' OR provider_path LIKE 'FASTAG%')
      GROUP BY 1, 2, 3 ORDER BY max(created_at) DESC LIMIT 12`);
  console.log('\nULIP calls in the last 3 hours:');
  if (!rows.length) console.log('  none — no lookup reached ULIP (paused, switched off, or no traffic)');
  for (const r of rows) console.log(`  ${String(r.provider_path).padEnd(12)} ${String(r.outcome || '').padEnd(10)} ${String(r.error_code || '').padEnd(8)} ×${r.n}  last ${ist(new Date(r.last).getTime())}`);

  if (!process.argv.includes('--try-login')) {
    console.log('\nRead-only — ULIP was not called. Add --try-login for ONE login attempt.');
    process.exit(0);
  }
  if (off) { console.log('\nNot trying: ULIP_LOGIN_OFF is set.'); process.exit(1); }
  if (paused) { console.log('\nNot trying: GaadiPe\'s own pause is running — a login now could keep the account locked. Wait for it to end.'); process.exit(1); }

  console.log('\nOne login attempt…');
  try {
    await require('../src/ulip/client').getToken({ force: true });
    console.log('✅ ULIP login WORKS — a token was issued. Lookups will use ULIP again.');
  } catch (e) {
    console.log(`❌ ${e.message.slice(0, 300)}`);
    console.log('\nWhat it usually means:');
    console.log('  "locked"            → ask ULIP support to unlock the account; do not try again meanwhile');
    console.log('  HTTP 412 / 403      → this server\'s IP is not on ULIP\'s allow-list (or ULIP is blocking it)');
    console.log('  HTTP 401            → username or password wrong / changed');
    console.log('  timeout / ECONNRESET→ ULIP itself is down — try again later');
    console.log('GaadiPe has paused its own logins after this refusal, and uses eChallan.app and the RC backup meanwhile.');
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
