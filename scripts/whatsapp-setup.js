/**
 * scripts/whatsapp-setup.js — is WhatsApp actually wired up?
 *
 * Answers, in the order they can fail:
 *
 *   1. are the five credentials present at all
 *   2. does the token work, and does it reach the WABA we think it does
 *   3. what is the number's status — registered, verified, what quality rating
 *   4. which templates Meta has, and which it has approved
 *
 * Read-only unless --register is passed, which performs the one-time Cloud API
 * registration a number needs before it can send. That call is idempotent: a
 * number already registered answers success and nothing changes.
 *
 *   node scripts/whatsapp-setup.js
 *   node scripts/whatsapp-setup.js --register --pin=641641
 */
require('dotenv').config();
const { config } = require('../src/config');

const w = config.whatsapp;
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const has = (v) => (v ? '✅' : '❌ missing');
const api = (path, init = {}) =>
  fetch(`https://graph.facebook.com/${w.apiVersion}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${w.token}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  }).then((r) => r.json());

(async () => {
  console.log('\n1. CREDENTIALS');
  console.log('   app id           ', has(w.appId), w.appId || '');
  console.log('   app secret       ', has(w.appSecret), w.appSecret ? '(hidden)' : '← inbound messages are rejected without it');
  console.log('   access token     ', has(w.token), w.token ? `(…${String(w.token).slice(-6)})` : '');
  console.log('   phone number id  ', has(w.phoneNumberId), w.phoneNumberId || '');
  console.log('   WABA id          ', has(w.businessId), w.businessId || '');
  console.log('   verify token     ', has(w.verifyToken));
  console.log('   own number       ', w.ownNumber || '❌ missing');
  console.log('   WHATSAPP_ENABLED ', w.enabled ? '✅ on' : '⚠️  off — the bot will not reply');
  console.log('   only messaging   ', w.allowedRecipients.length ? w.allowedRecipients.join(', ') : '⚠️  EVERYONE (test guard is off)');

  if (!w.token || !w.phoneNumberId || !w.businessId) {
    console.log('\nNothing more can be checked until the token, phone number id and WABA id are set.\n');
    process.exit(1);
  }

  console.log('\n2. THE NUMBER');
  const num = await api(`${w.phoneNumberId}?fields=display_phone_number,verified_name,code_verification_status,quality_rating,platform_type,status,name_status,messaging_limit_tier,throughput`);
  if (num.error) {
    console.log('   ❌', num.error.code + ':', num.error.message);
    console.log('\n   190 means the token belongs to a deleted or wrong app.');
    console.log('   131xxx usually means the number is not on this WABA.\n');
    process.exit(1);
  }
  for (const [k, v] of Object.entries(num)) {
    if (k === 'id') continue;
    console.log('   ' + k.padEnd(24) + (typeof v === 'object' ? JSON.stringify(v) : v));
  }

  const registered = String(num.platform_type || '').toUpperCase().includes('CLOUD');
  console.log('\n   on Cloud API      ' + (registered ? '✅ yes' : '⚠️  not registered — it cannot send yet'));

  /* The one-time registration. Idempotent, so running it twice is harmless. */
  if (process.argv.includes('--register')) {
    const pin = arg('pin');
    if (!/^\d{6}$/.test(String(pin || ''))) {
      console.log('\n   --register needs a six-digit PIN: --pin=123456\n');
      process.exit(1);
    }
    console.log('\n   registering on Cloud API…');
    const out = await api(`${w.phoneNumberId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin: String(pin) }),
    });
    console.log('  ', out.error
      ? `❌ ${out.error.code}: ${out.error.message}`
      : `✅ ${JSON.stringify(out)}`);
    if (out.error?.code === 133005) {
      console.log('   That PIN does not match the one set on the number. Reset it in');
      console.log('   Business Manager → WhatsApp Manager → the number → Two-step verification.');
    }
  }

  console.log('\n3. TEMPLATES META HAS');
  const t = await api(`${w.businessId}/message_templates?limit=50&fields=name,language,status,category`);
  if (t.error) {
    console.log('   ❌', t.error.code + ':', t.error.message);
  } else if (!(t.data || []).length) {
    console.log('   none yet — raise them in WhatsApp Manager.');
  } else {
    for (const x of t.data) {
      const ok = x.status === 'APPROVED' ? '✅' : x.status === 'REJECTED' ? '❌' : '⏳';
      console.log(`   ${ok} ${String(x.name).padEnd(30)} ${String(x.language).padEnd(6)} ${String(x.category || '').padEnd(10)} ${x.status}`);
    }
    console.log('\n   The Broadcast screen reads this same list, and writes the');
    console.log('   statuses back into wa_templates on every refresh.');
  }

  console.log('\n4. WEBHOOK');
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  console.log('   callback URL      ' + base + '/serverpe/platform/gaadipe/v1/public/users/whatsapp/webhook');
  console.log('   subscribe to      messages, message_template_status_update');
  console.log();
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.message, '\n'); process.exit(1); });
