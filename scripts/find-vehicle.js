/**
 * scripts/find-vehicle.js — EVERY TRACE OF A VEHICLE NUMBER (user, 2026-10-27: a customer asked about WB34AF6056, which
 * is "not in GaadiPe's records yet" - so what did they actually type?). Read-only; no lookup, nothing sent.
 *
 *   node scripts/find-vehicle.js WB34AF6056      exact number, and anything starting with its first 6 (WB34AF…)
 *
 * Looks in: saved vehicles, checks (found or not), website checks before sign-in, and WhatsApp messages.
 */
require('dotenv').config();
const db = require('../src/db');

const reg = String(process.argv[2] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
if (reg.length < 6) { console.log('usage: node scripts/find-vehicle.js WB34AF6056'); process.exit(1); }
const like = `${reg.slice(0, 6)}%`;
const ist = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '-');
const q = (sql, args) => db.query(sql, args).then((r) => r.rows).catch((e) => [{ error: e.message }]);

(async () => {
  console.log(`\nLooking for ${reg} (and anything starting ${reg.slice(0, 6)}…)\n`);

  const veh = await q(`SELECT reg_no, maker, model FROM vehicles WHERE reg_no LIKE $1 ORDER BY reg_no LIMIT 20`, [like]);
  console.log('Saved vehicles:'); if (!veh.length) console.log('  none');
  for (const v of veh) console.log(`  ${v.reg_no}${v.maker ? ` · ${v.maker} ${v.model || ''}` : ''}${v.error ? v.error : ''}`);

  const checks = await q(
    `SELECT e.created_at, e.kind, e.detail->>'reg_no' AS reg, e.detail->>'found' AS found, e.detail->>'channel' AS ch, right(u.mobile, 10) AS mobile
       FROM event_log e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.kind IN ('vehicle_check', 'vehicle_check_repeat') AND upper(e.detail->>'reg_no') LIKE $1
      ORDER BY e.created_at DESC LIMIT 20`, [like]);
  console.log('\nChecks by customers:'); if (!checks.length) console.log('  none');
  for (const c of checks) console.log(c.error ? `  ${c.error}` : `  ${ist(c.created_at)}  ${c.reg}${c.found === 'false' ? ' · NOT FOUND' : ''} · ${c.ch || 'whatsapp'} · ${c.mobile || '?'}`);

  const anon = await q(`SELECT created_at, reg_no, outcome FROM anon_checks WHERE upper(reg_no) LIKE $1 ORDER BY created_at DESC LIMIT 20`, [like]);
  console.log('\nWebsite checks before sign-in:'); if (!anon.length) console.log('  none');
  for (const a of anon) console.log(a.error ? `  ${a.error}` : `  ${ist(a.created_at)}  ${a.reg_no} · ${a.outcome}`);

  const msgs = await q(
    `SELECT created_at, mobile, left(regexp_replace(body, '\\s+', ' ', 'g'), 100) AS body FROM whatsapp_messages
      WHERE direction = 'in' AND upper(regexp_replace(coalesce(body, ''), '[^A-Za-z0-9]', '', 'g')) LIKE $1
      ORDER BY created_at DESC LIMIT 20`, [`%${reg.slice(0, 6)}%`]);
  console.log('\nWhatsApp messages that mention it:'); if (!msgs.length) console.log('  none');
  for (const m of msgs) console.log(m.error ? `  ${m.error}` : `  ${ist(m.created_at)}  …${String(m.mobile).slice(-4)}  ${m.body}`);
  console.log('');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
