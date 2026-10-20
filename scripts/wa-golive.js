/**
 * scripts/wa-golive.js — SWITCHING THE NEW WHATSAPP NUMBER ON, SAFELY (user, 2026-10-20: new
 * portfolio, new number +91 73531 22415). Changes only GaadiPe's own settings (app_settings) —
 * never calls Meta, never sends a message. The running server picks a change up within a minute.
 *
 *   node scripts/wa-golive.js status   what is on, what is off, what is missing
 *   node scripts/wa-golive.js test     ON for the owner's number only — needs
 *                                       WHATSAPP_ALLOWED_RECEPIENTS in .env (the safety lock)
 *   node scripts/wa-golive.js live     ON for everyone — run only after the test, and after
 *                                       removing WHATSAPP_ALLOWED_RECEPIENTS from .env + restart
 *   node scripts/wa-golive.js off      everything WhatsApp stops at once
 *
 * What "on" sets:
 *   whatsapp_number_since     now, once — chats and agreements before it belong to the old,
 *                             banned number (send.numberSince): old customers get nothing from
 *                             the new number until they write to it
 *   whatsapp_sending_enabled  true
 *   the template settings     emptied if they still name the old account's templates, which the
 *                             new account does not have (set them again once Meta approves
 *                             gp_vehicle_reminder_v1 / gp_monitoring_renewal_v1)
 */
require('dotenv').config();
const db = require('../src/db');
const { config } = require('../src/config');

const cmd = process.argv[2] || 'status';
const TEMPLATE_KEYS = ['wa_template_monitoring', 'template_daily_status', 'wa_template_renewal'];
// The old account's templates — none exists on the new one.
const OLD = /^(gp_monitoringalert_en_v1|gp_monitoring_alert_en_v2|gv_vehiclealert_en_v1|gp_vehicle_alert_v2|gp_vehicle_check_alert_v1|gp_owner_verification_update_v1|gp_starthere_en_v1|gp_announcement_\w+|gp_renewal_en_v1)$/;

const get = async (key) => (await db.one(`SELECT value FROM app_settings WHERE key = $1`, [key]))?.value ?? null;
const set = (key, value) => db.query(
  `INSERT INTO app_settings (key, value) VALUES ($1, $2)
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [key, value]);

async function status() {
  const lock = config.whatsapp.allowedRecipients;
  console.log('\nWHATSAPP — NEW NUMBER');
  console.log('  number in .env            ', config.whatsapp.ownNumber || '❌ missing', `(id ${config.whatsapp.phoneNumberId || '—'})`);
  console.log('  WHATSAPP_ENABLED (.env)   ', config.whatsapp.enabled ? 'on' : 'off');
  console.log('  safety lock (.env)        ', lock.length ? `🔒 only ${lock.join(', ')}` : '🔓 EVERYONE');
  console.log('  whatsapp_sending_enabled  ', String(await get('whatsapp_sending_enabled')));
  console.log('  whatsapp_number_since     ', (await get('whatsapp_number_since')) || '(not set — old chats would count)');
  for (const k of TEMPLATE_KEYS) {
    const v = await get(k);
    console.log(`  ${k.padEnd(26)}`, v ? `${v}${OLD.test(v) ? '   ⚠️ old account\'s template' : ''}` : '(none)');
  }
  console.log();
}

async function on({ everyone }) {
  const lock = config.whatsapp.allowedRecipients;
  if (!everyone && !lock.length) {
    console.log('\n❌ Not switched on: add the safety lock first —');
    console.log('   WHATSAPP_ALLOWED_RECEPIENTS=9886122415   in .env, then  pm2 restart serverpe-gaadipe --update-env\n');
    process.exit(1);
  }
  if (everyone && lock.length) {
    console.log(`\n❌ Not switched on for everyone: the safety lock is still in .env (only ${lock.join(', ')}).`);
    console.log('   Remove WHATSAPP_ALLOWED_RECEPIENTS from .env, pm2 restart serverpe-gaadipe --update-env, then run this again.\n');
    process.exit(1);
  }
  if (!config.whatsapp.token || !config.whatsapp.phoneNumberId) {
    console.log('\n❌ The token or phone number id is missing in .env.\n');
    process.exit(1);
  }
  if (!(await get('whatsapp_number_since'))) {
    await set('whatsapp_number_since', new Date().toISOString());
    console.log('✅ whatsapp_number_since set to now — only people who write to the new number get anything from it');
  }
  for (const k of TEMPLATE_KEYS) {
    const v = await get(k);
    if (v && OLD.test(v)) { await set(k, ''); console.log(`✅ ${k} emptied (was the old account's ${v})`); }
  }
  await set('whatsapp_sending_enabled', 'true');
  console.log(`✅ WhatsApp sending ON${everyone ? ' for everyone' : ` — only ${lock.join(', ')} (safety lock)`}. The server picks it up within a minute.`);
  await status();
}

(async () => {
  if (cmd === 'status') await status();
  else if (cmd === 'test') await on({ everyone: false });
  else if (cmd === 'live') await on({ everyone: true });
  else if (cmd === 'off') { await set('whatsapp_sending_enabled', 'false'); console.log('\n🛑 WhatsApp sending OFF. Nothing goes out from the next minute.'); await status(); }
  else { console.log('usage: node scripts/wa-golive.js status | test | live | off'); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
