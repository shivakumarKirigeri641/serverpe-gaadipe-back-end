/**
 * src/jobs/metaStatus.js — the WhatsApp account as Meta sees it, read live
 * every hour (user, 2026-10-02: "get APIs for the status of my business in
 * Meta"). Read-only Graph API calls; nothing on Meta's side is changed.
 *
 *   phone number   messaging_limit_tier, quality_rating, status, name_status
 *   WhatsApp acct  business verification, account review, can it send
 *   all numbers    how many numbers the account holds
 *
 * Kept as the setting meta_wa_status (JSON) for the admin panel; the messaging
 * limit setting follows Meta's tier, so the Home tile and the Broadcast banner
 * stop relying on a number typed by hand. When the tier or the quality changes,
 * the admin is emailed (and a quality drop is an alert).
 */

const db = require('../db');
const settings = require('../util/settings');
const { config } = require('../config');

const TIERS = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: null };

async function graph(path) {
  const wa = config.whatsapp;
  const url = `https://graph.facebook.com/${wa.apiVersion}/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${wa.token}` }, signal: AbortSignal.timeout(20000) });
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(`${json.error.code}: ${json.error.message}`);
  return json;
}

/** Ask Meta now. Returns the stored status. */
async function refresh() {
  const wa = config.whatsapp;
  if (!wa.token || !wa.phoneNumberId) return null;
  const waba = String(await settings.get('whatsapp_waba_id', '1529987455442947'));

  const [phone, account, numbers] = await Promise.all([
    graph(`${wa.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,throughput,name_status,status,account_mode`),
    graph(`${waba}?fields=name,account_review_status,business_verification_status,health_status`).catch((e) => ({ error: e.message })),
    graph(`${waba}/phone_numbers?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,status`).catch(() => ({ data: [] })),
  ]);

  const status = {
    checked_at: new Date().toISOString(),
    number: phone.display_phone_number || null,
    name: phone.verified_name || null,
    tier: phone.messaging_limit_tier || null,
    limit: phone.messaging_limit_tier in TIERS ? TIERS[phone.messaging_limit_tier] : null,
    quality: phone.quality_rating || null,
    status: phone.status || null,
    name_status: phone.name_status || null,
    throughput: phone.throughput?.level || null,
    mode: phone.account_mode || null,
    business_verification: account.business_verification_status || null,
    account_review: account.account_review_status || null,
    can_send: account.health_status?.can_send_message || null,
    numbers: (numbers.data || []).map((n) => ({
      number: n.display_phone_number, name: n.verified_name, quality: n.quality_rating, tier: n.messaging_limit_tier, status: n.status,
    })),
  };

  const before = JSON.parse(await settings.get('meta_wa_status', 'null') || 'null');
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ('meta_wa_status', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [JSON.stringify(status)]);
  // The limit everyone else reads follows Meta (an unlimited tier keeps the last number).
  if (status.limit) {
    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ('whatsapp_messaging_limit', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [String(status.limit)]);
  }
  settings.refresh();

  if (before && (before.tier !== status.tier || before.quality !== status.quality)) await changed(before, status);
  return status;
}

const QUALITY = { GREEN: '🟢 High', YELLOW: '🟡 Medium', RED: '🔴 Low', UNKNOWN: '—' };
const tierText = (t) => (t === 'TIER_UNLIMITED' ? 'Unlimited' : TIERS[t] ? `${TIERS[t].toLocaleString('en-IN')} people / 24 h` : t || '—');

async function changed(before, now) {
  const up = (TIERS[now.tier] ?? Infinity) > (TIERS[before.tier] ?? 0);
  const worse = ['GREEN', 'YELLOW', 'RED'].indexOf(now.quality) > ['GREEN', 'YELLOW', 'RED'].indexOf(before.quality);
  console.log('[meta] WhatsApp status changed: tier %s -> %s, quality %s -> %s', before.tier, now.tier, before.quality, now.quality);
  if (worse) {
    await require('../admin/alerts').raise({
      key: 'whatsapp_quality_drop', severity: now.quality === 'RED' ? 'critical' : 'warning', source: 'whatsapp',
      title: `WhatsApp quality is now ${QUALITY[now.quality] || now.quality}`,
      description: 'Meta lowered the quality rating of the GaadiPe number — usually from blocks or reports. Pause broadcasts and reminders until it recovers.',
      detail: { before: before.quality, now: now.quality },
    }).catch(() => {});
  }
  const T = require('../mail/templates');
  const title = before.tier !== now.tier
    ? (up ? `🎉 WhatsApp limit raised to ${tierText(now.tier)}` : `WhatsApp limit lowered to ${tierText(now.tier)}`)
    : `WhatsApp quality: ${QUALITY[now.quality] || now.quality}`;
  await require('../mail/mailer').send({
    subject: title,
    ...T.layout({
      badge: { text: 'Meta · WhatsApp', tone: worse || (!up && before.tier !== now.tier) ? 'wrong' : 'good' },
      title,
      lead: `Read from Meta at ${T.ist(now.checked_at)} for ${now.number || 'the GaadiPe number'}.`,
      sections: [{ heading: 'Before → now', rows: [
        ['Messaging limit', `${tierText(before.tier)} → ${tierText(now.tier)}`],
        ['Quality', `${QUALITY[before.quality] || before.quality} → ${QUALITY[now.quality] || now.quality}`],
      ] }],
      cta: { label: 'Open the panel', path: '/' },
    }),
  }).catch(() => {});
}

/** What the panel shows: the stored status (refreshed if older than two hours). */
async function current() {
  let s = JSON.parse(await settings.get('meta_wa_status', 'null') || 'null');
  if (!s || Date.now() - new Date(s.checked_at).getTime() > 2 * 3600e3) s = await refresh().catch(() => s);
  return s;
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { await refresh(); } catch (e) { console.error('[meta] status:', e.message); } finally { running = false; }
}

function start(everySeconds = 3600) {
  setTimeout(tick, 60 * 1000);
  setInterval(tick, everySeconds * 1000).unref();
  console.log(`  meta status: every ${everySeconds}s`);
}

module.exports = { start, refresh, current, TIERS };
