/**
 * scripts/test-alert.js — SEND THE MONITORING ALERT TEMPLATE TO ONE NUMBER (user, 2026-10-15:
 * "give me a script to send the template to me"). To see exactly what customers get, and to
 * try its three buttons.
 *
 *   node scripts/test-alert.js 9886122415              one of that number's vehicles
 *   node scripts/test-alert.js 9886122415 KA01AB1234   that vehicle
 *   node scripts/test-alert.js 9886122415 --dry        print what would go, send nothing
 *
 * Goes ONLY to the number given, as the approved template (Settings wa_template_monitoring,
 * now gv_vehiclealert_en_v1) with its three buttons — a real vehicle's id, so the taps work
 * as they do for customers. The status line says it is a test. Respects every switch the
 * real alerts obey (whatsapp_sending_enabled, STOP, the consent gate): if one of them stops
 * it, the reason is printed.
 */
require('dotenv').config();
const db = require('../src/db');

const args = process.argv.slice(2);
const mobile = String(args[0] || '').replace(/\D/g, '').slice(-10);
const regArg = args.find((a, i) => i > 0 && !a.startsWith('--'));
const dry = args.includes('--dry');

(async () => {
  if (mobile.length !== 10) {
    console.log('Usage: node scripts/test-alert.js <10-digit mobile> [VEHICLE] [--dry]');
    process.exit(1);
  }
  const user = await db.one(
    `SELECT id, coalesce(display_name, wa_profile_name) AS name FROM users WHERE right(mobile, 10) = $1`, [mobile]);
  if (!user) { console.log(`No customer with ${mobile}. Say Hi to the bot from that number first.`); process.exit(1); }

  const v = regArg
    ? await db.one(`SELECT id, reg_no, insurance_upto::text AS insurance_upto FROM vehicles WHERE upper(reg_no) = upper($1)`,
      [regArg.replace(/[^A-Za-z0-9]/g, '')]).catch(() => null)
    : await db.one(`SELECT v.id, v.reg_no, v.insurance_upto::text AS insurance_upto FROM vehicles v
                      JOIN user_vehicles uv ON uv.vehicle_id = v.id AND uv.user_id = $1 AND uv.hidden_at IS NULL
                     ORDER BY v.id DESC LIMIT 1`, [user.id]).catch(() => null);
  const vehicle = v?.reg_no || (regArg ? regArg.toUpperCase() : 'KA01AB1234');
  const values = {
    name: String(user.name || 'there').split(' ')[0],
    vehicle,
    vehicleId: v?.id || 0,
    document: 'Insurance',
    expiry: v?.insurance_upto ? new Date(`${v.insurance_upto}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Not on record',
    status: 'Test message from GaadiPe — please ignore',
    kind: 'exp',
    docs: ['insurance'],
  };
  const tpl = await require('../src/util/settings').get('wa_template_monitoring', 'gp_monitoringalert_en_v1');
  console.log(`To ${mobile} · template ${tpl}`);
  console.log(`  {{1}} ${values.name}\n  {{2}} ${values.vehicle}\n  {{3}} ${values.document}\n  {{4}} ${values.expiry}\n  {{5}} ${values.status}`);
  console.log('  buttons: Thanks for remembering · Check vehicle · Pause this alert');
  if (dry) { console.log('\nDry run — nothing sent.'); process.exit(0); }

  const out = await require('../src/whatsapp/monitorAlert').sendAlert(mobile, values);
  console.log(out.ok ? `\nSent ✓ (message id ${out.id || '—'})` : `\nNot sent: ${out.error || 'unknown reason'}`);
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
