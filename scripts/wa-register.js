/**
 * scripts/wa-register.js
 * ---------------------------------------------------------------------------
 * Register a WhatsApp phone number on the Cloud API, point it at our webhook,
 * and check its status.
 *
 *   node scripts/wa-register.js status          what Meta thinks of the number
 *   node scripts/wa-register.js register 123456 register it with a 6-digit PIN
 *   node scripts/wa-register.js webhook <url>   send THIS number's events to us
 *   node scripts/wa-register.js webhook clear   drop that override
 *   node scripts/wa-register.js deregister      release it from the Cloud API
 *
 * WHY REGISTER EXISTS: adding a number in WhatsApp Manager makes it *known* to
 * the business account, but it is not usable by the API until it is REGISTERED
 * against a phone-number id with a two-step PIN. Skip this and the number looks
 * present in the UI while every send fails.
 *
 * Reads WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN from .env, so the
 * token never appears in a command line or shell history.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const V = process.env.WHATSAPP_API_VERSION || 'v21.0';
const ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const [action, arg] = process.argv.slice(2);

if (!ID || !TOKEN) {
  console.error('\n  WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN must be set in .env\n');
  process.exit(1);
}

const call = async (path, method = 'GET', body) => {
  const res = await fetch(`https://graph.facebook.com/${V}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};

/** Meta's own view of the number — the truth, whatever the UI shows. */
async function status() {
  const fields = 'verified_name,display_phone_number,quality_rating,platform_type,'
    + 'code_verification_status,status,throughput,webhook_configuration';
  const { status: s, json } = await call(`${ID}?fields=${fields}`);
  console.log(`\nHTTP ${s}`);
  if (json.error) {
    console.log('  error:', json.error.message);
    return;
  }
  console.log(`  number     : ${json.display_phone_number || '-'}`);
  console.log(`  name       : ${json.verified_name || '-'}`);
  console.log(`  platform   : ${json.platform_type || '-'}   <- CLOUD_API once registered`);
  console.log(`  status     : ${json.status || '-'}`);
  console.log(`  quality    : ${json.quality_rating || '-'}`);
  console.log(`  name check : ${json.code_verification_status || '-'}`);
  const w = json.webhook_configuration || {};
  console.log(`  webhook    : ${w.override_callback_uri || w.application || 'not configured'}`
    + `${w.override_callback_uri ? '  (this number only)' : '  (inherited from the app)'}`);
  console.log();
}

async function register(p) {
  if (!/^\d{6}$/.test(String(p || ''))) {
    console.error('\n  a 6-digit PIN is required:  node scripts/wa-register.js register 123456\n');
    process.exit(1);
  }
  const { status: s, json } = await call(`${ID}/register`, 'POST', {
    messaging_product: 'whatsapp',
    pin: String(p),
  });
  console.log(`\nHTTP ${s}`, JSON.stringify(json));
  if (json.success === true) {
    console.log('\n  registered. Checking what Meta reports now:');
    await status();
    return;
  }
  const msg = json.error?.message || '';
  // The two failures that actually happen, and what to do about each.
  if (/pin/i.test(msg) && /mismatch|incorrect|match/i.test(msg)) {
    console.log('\n  The number already has a different two-step PIN set.');
    console.log('  Reset it in WhatsApp Manager -> the number -> Two-step verification,');
    console.log('  then run this again with the new PIN.\n');
  } else if (/already/i.test(msg)) {
    console.log('\n  Already registered - nothing to do.\n');
  } else {
    console.log();
  }
}

/**
 * Point this one number at its own webhook.
 *
 * WHY AN OVERRIDE AND NOT A SECOND APP SUBSCRIPTION: subscriptions are per
 * WhatsApp Business ACCOUNT, and this number shares its account with QuizPe.
 * Subscribing a second app would deliver both products' messages to both
 * backends, leaving each to filter out the other's. A per-number override keeps
 * that split at Meta's end, where it cannot be got wrong in code.
 *
 * Meta verifies the URL immediately with a GET carrying hub.challenge, so the
 * endpoint must already be deployed and answering when this runs.
 */
async function webhook(url) {
  if (url === 'clear') {
    const { status: s, json } = await call(ID, 'POST',
      { webhook_configuration: { override_callback_uri: '' } });
    console.log(`\nHTTP ${s}`, JSON.stringify(json), '\n');
    return;
  }
  const verify = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!/^https:\/\//.test(String(url || ''))) {
    console.error('\n  an https URL is required:'
      + '\n  node scripts/wa-register.js webhook https://api.gaadipe.in/webhook/whatsapp\n');
    process.exit(1);
  }
  if (!verify) {
    console.error('\n  WHATSAPP_VERIFY_TOKEN must be set in .env - Meta echoes it back'
      + '\n  to prove the endpoint is ours.\n');
    process.exit(1);
  }
  const { status: s, json } = await call(ID, 'POST', {
    webhook_configuration: { override_callback_uri: url, verify_token: verify },
  });
  console.log(`\nHTTP ${s}`, JSON.stringify(json));
  if (json.success === true) {
    console.log('\n  override set. Confirming:');
    await status();
  } else {
    // Meta only accepts a URL it could verify, so a failure here is almost
    // always the endpoint rather than this call.
    console.log('\n  Meta could not verify the URL. The endpoint must answer'
      + '\n  GET ?hub.mode=subscribe&hub.verify_token=<ours>&hub.challenge=123'
      + '\n  with the body 123 and HTTP 200, over https, publicly reachable.\n');
  }
}

async function deregister() {
  const { status: s, json } = await call(`${ID}/deregister`, 'POST');
  console.log(`\nHTTP ${s}`, JSON.stringify(json), '\n');
}

(async () => {
  if (action === 'register') return register(arg);
  if (action === 'webhook') return webhook(arg);
  if (action === 'deregister') return deregister();
  if (action === 'status' || !action) return status();
  console.log('\nusage: node scripts/wa-register.js [status|register <pin>|webhook <url>|deregister]\n');
})().catch((e) => { console.error('\nfailed:', e.message, '\n'); process.exit(1); });
