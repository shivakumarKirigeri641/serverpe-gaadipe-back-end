/**
 * scripts/wa-check.js — EVERY WHATSAPP CHECK IN ONE GO, READ-ONLY (user, 2026-10-22: "give me the GET API
 * scripts once" — setting up a number whose messages stayed on a single tick). Only GET calls to Meta's
 * Graph API, with the .env's token; it changes nothing, sends nothing, and never prints the token.
 *
 *   node scripts/wa-check.js
 *
 * What it reads:
 *   1 the phone number    status, Cloud API, display name review, quality, messaging limit, health
 *   2 the account (WABA)  name, review status, currency, health
 *   3 subscribed apps     empty = Meta has nowhere to deliver incoming messages (single tick)
 *   4 the token           whose it is, its scopes, when it expires
 *   5 templates           names, category and status
 *   6 GaadiPe's side      the switches in app_settings and the webhook settings in .env
 */
require('dotenv').config();
const db = require('../src/db');
const { config } = require('../src/config');

const V = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const wa = config.whatsapp;
const TOKEN = wa.token;
const G = async (path) => {
  try {
    const res = await fetch(`https://graph.facebook.com/${V}/${path}`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));
    return body.error ? { error: `${body.error.message} (code ${body.error.code}${body.error.error_subcode ? `/${body.error.error_subcode}` : ''})` } : body;
  } catch (e) { return { error: e.message }; }
};
const show = (title, obj) => { console.log(`\n── ${title}`); console.log(JSON.stringify(obj, null, 2).replace(/"access_token":\s*"[^"]+"/g, '"access_token": "•••"')); };

(async () => {
  console.log(`WhatsApp check (Graph ${V}) — read-only`);
  if (!TOKEN) { console.log('❌ WHATSAPP_ACCESS_TOKEN is empty in .env'); process.exit(1); }
  console.log(`phone number id ${wa.phoneNumberId || '❌ missing'} · WABA id ${wa.businessId || '❌ missing'} · app id ${wa.appId || '—'}`);

  // 1. The phone number
  if (wa.phoneNumberId) {
    show('1. Phone number', await G(`${wa.phoneNumberId}?fields=display_phone_number,verified_name,status,platform_type,code_verification_status,name_status,quality_rating,messaging_limit_tier,throughput,account_mode,health_status`));
  }
  // 2. The WhatsApp Business Account
  if (wa.businessId) {
    show('2. WhatsApp Business Account', await G(`${wa.businessId}?fields=name,account_review_status,business_verification_status,currency,message_template_namespace,health_status`));
    show('2b. Numbers on this account', await G(`${wa.businessId}/phone_numbers?fields=id,display_phone_number,verified_name,status,platform_type`));
    // 3. Subscribed apps
    const subs = await G(`${wa.businessId}/subscribed_apps`);
    show('3. Apps subscribed to this account', subs);
    if (Array.isArray(subs.data) && !subs.data.length) console.log('   ⚠️  EMPTY: Meta has nowhere to deliver incoming messages — subscribe the app (POST …/subscribed_apps).');
    // 5. Templates
    const t = await G(`${wa.businessId}/message_templates?fields=name,status,category,language&limit=50`);
    console.log('\n── 5. Templates');
    if (t.error) console.log(`   ${t.error}`);
    else if (!(t.data || []).length) console.log('   (none)');
    else for (const x of t.data) console.log(`   ${x.status.padEnd(9)} ${x.category.padEnd(15)} ${x.language.padEnd(6)} ${x.name}`);
  }
  // 4. The token itself
  const me = await G('me?fields=id,name');
  show('4. Token belongs to', me);
  const perms = await G('me/permissions');
  if (Array.isArray(perms.data)) console.log(`   scopes: ${perms.data.filter((p) => p.status === 'granted').map((p) => p.permission).join(', ') || '(none listed — system-user tokens list them in Business Settings)'}`);

  // 6. GaadiPe's own switches
  console.log('\n── 6. GaadiPe settings');
  const keys = ['whatsapp_sending_enabled', 'flag_whatsapp_flow', 'whatsapp_number_since', 'wa_template_monitoring', 'template_daily_status', 'wa_template_renewal'];
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [keys]);
  for (const k of keys) console.log(`   ${k.padEnd(26)} ${rows.find((r) => r.key === k)?.value ?? '(not set)'}`);
  console.log(`   WHATSAPP_ENABLED (.env)     ${wa.enabled ? 'on' : 'off'}`);
  console.log(`   app secret (.env)           ${wa.appSecret ? 'set' : '❌ missing — webhook signatures not checked'}`);
  console.log(`   verify token (.env)         ${wa.verifyToken ? 'set' : '❌ missing — Meta cannot verify the webhook'}`);
  // allowedRecipients is a list of 10-digit numbers — an empty list means no lock (replies to everyone).
  const lock = Array.isArray(wa.allowedRecipients) ? wa.allowedRecipients : [];
  console.log(`   safety lock (.env)          ${lock.length ? `ON — replies only to ${lock.map((m) => `••••••${m.slice(-4)}`).join(', ')}` : '⚠️  OFF — the bot replies to EVERYONE who writes'}`);
  console.log(`   webhook URL                 https://api.gaadipe.in/serverpe/platform/gaadipe/v1/public/users/whatsapp/webhook\n`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
