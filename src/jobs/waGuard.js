/**
 * src/jobs/waGuard.js — THE WHATSAPP FAILSAFE (user, 2026-10-23: "really concerned if Meta disables it at
 * midnight — this would avoid me getting up at midnight").
 *
 * Every 10 minutes, and at once when Meta's webhook reports account news, it asks Meta (read-only GET) whether
 * GaadiPe's number can still send. If Meta says it cannot — the number, the WhatsApp account or the business
 * BLOCKED, or the number banned / disconnected — it switches GaadiPe to the web on its own:
 *
 *   site_whatsapp_try = false     the "Try in WhatsApp" button disappears from gaadipe.in
 *   site_moved_notice = true      the "GaadiPe is now fully on the web" sign …
 *   site_notice_on    = true      … and the green top bar come back
 *   whatsapp_sending_enabled = false   nothing more goes out on WhatsApp
 *
 * — exactly scripts/wa-button.js web-only + scripts/wa-golive.js off — and tells the owner at once (panel alert,
 * phone notification, email, and an SMS to the admin number). It NEVER switches WhatsApp back on: that stays the
 * owner's decision (wa-button.js whatsapp + wa-golive.js live).
 *
 * Quality falling to RED pauses templates for 7 days (replies still go) and tells the owner; YELLOW tells only.
 * An expired or wrong token (Graph error 190) is told, never acted on — that is our side, not a ban. Other Graph
 * errors act only when seen twice in a row, so one network blip cannot take WhatsApp down.
 */
const db = require('../db');
const settings = require('../util/settings');
const { config } = require('../config');

const BAD_STATUS = ['BANNED', 'DISCONNECTED', 'DELETED', 'RESTRICTED'];
let oddErrors = 0;
let netErrors = 0;
let running = false;

async function graph(path) {
  const wa = config.whatsapp;
  const res = await fetch(`https://graph.facebook.com/${wa.apiVersion}/${path}`,
    { headers: { Authorization: `Bearer ${wa.token}` }, signal: AbortSignal.timeout(20000) });
  const json = await res.json().catch(() => ({}));
  if (json.error) { const e = new Error(json.error.message || 'Graph error'); e.code = json.error.code; throw e; }
  return json;
}

const set = (key, value) => db.query(
  `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`,
  [key, value]);

/** Tell the owner every way there is. Never throws. */
async function tellOwner({ key, title, text, severity = 'critical' }) {
  await require('../util/adminPing').ping({ key, title, text, severity, source: 'whatsapp' }).catch(() => {});
  // An SMS too (the approved status template: "GaadiPe update for {#var#}: {#var#}. Visit: gaadipe.in"),
  // to the admin numbers — the alert that wakes nobody but is there first thing in the morning.
  try {
    const sms = require('../util/sms');
    for (const m of await require('../util/adminPing').adminNumbers()) {
      await sms.sendTemplate('status', m, ['GaadiPe WhatsApp', text.slice(0, 30)]).catch(() => {});
    }
  } catch { /* SMS not set up */ }
}

/** Switch GaadiPe to the web. */
async function failover(why, detail) {
  await set('site_whatsapp_try', 'false');
  await set('site_moved_notice', 'true');
  await set('site_notice_on', 'true');
  await set('whatsapp_sending_enabled', 'false');
  settings.refresh();
  await db.query(`INSERT INTO event_log (kind, detail) VALUES ('whatsapp_failover', $1)`,
    [JSON.stringify({ why, detail, at: new Date().toISOString() })]).catch(() => {});
  console.error('[waGuard] WHATSAPP BLOCKED (%s) — switched GaadiPe to the web: button hidden, notices on, sending off', why);
  require('../util/activity').log('🛑', `WhatsApp blocked by Meta (${why}) — GaadiPe switched to the web automatically`, { who: 'the failsafe' });
  await tellOwner({
    key: 'whatsapp_failover',
    title: '🛑 WhatsApp blocked — GaadiPe switched to the web',
    text: `Meta reports GaadiPe's WhatsApp cannot send (${why}). The failsafe hid "Try in WhatsApp", put the "fully on the web" notices back and stopped WhatsApp sending. The website, SMS and email run as usual. Next: pause the WhatsApp ad; SMS the customers (node scripts/wa-number-customers.js --csv wa.csv). To undo after a review: node scripts/wa-button.js whatsapp && node scripts/wa-golive.js live.`,
  });
}

/** One check. `why` says what triggered it (the timer, or a webhook field). Returns what it decided. */
async function check(why = 'timer') {
  const wa = config.whatsapp;
  if (!wa.token || !wa.phoneNumberId) return { skipped: 'no WhatsApp details in .env' };
  // Already off — by the owner or by an earlier failover: nothing to guard.
  if (!(await settings.bool('whatsapp_sending_enabled', false))) return { skipped: 'whatsapp already off' };
  if (running) return { skipped: 'already running' };
  running = true;
  try {
    let phone;
    try {
      phone = await graph(`${wa.phoneNumberId}?fields=status,quality_rating,health_status,display_phone_number`);
      oddErrors = 0; netErrors = 0;
    } catch (e) {
      if (e.code === 190) {   // our token, not a ban
        await tellOwner({ key: 'whatsapp_token', severity: 'warning', title: '⚠️ WhatsApp token not accepted by Meta',
          text: `The failsafe could not read the WhatsApp number: ${e.message}. Replace WHATSAPP_ACCESS_TOKEN in .env and restart.` });
        return { decided: 'token problem — told, not acted on' };
      }
      /* No answer at all (no Graph error code) is OUR network, not a ban: told after 3 in a row, never acted on.
         A Graph error about the number itself (e.g. 100 "does not exist", 10/200 permission) twice in a row is
         Meta taking the number away: switch to the web. */
      if (!e.code) {
        oddErrors = 0;
        netErrors += 1;
        console.warn('[waGuard] could not reach Meta (%s, %d in a row)', e.message, netErrors);
        if (netErrors === 3) {
          await tellOwner({ key: 'whatsapp_guard_unreachable', severity: 'warning', title: '⚠️ Failsafe cannot reach Meta',
            text: `The WhatsApp failsafe could not reach Meta 3 times in a row (${e.message}) — the server's internet or Meta is down. Nothing was switched.` });
        }
        return { decided: 'network error — not acted on' };
      }
      oddErrors += 1;
      console.warn('[waGuard] Meta refused the read (%s %s, %d in a row)', e.code, e.message, oddErrors);
      if (oddErrors >= 2) { await failover(`Meta error ${e.code}: ${e.message}`, { trigger: why }); return { decided: 'failover (repeated Meta errors)' }; }
      return { decided: 'waiting — one Meta error' };
    }

    const entities = phone.health_status?.entities || [];
    const blocked = entities.filter((x) => ['PHONE_NUMBER', 'WABA', 'BUSINESS'].includes(x.entity_type) && x.can_send_message === 'BLOCKED');
    const top = phone.health_status?.can_send_message;
    if (blocked.length || top === 'BLOCKED' || BAD_STATUS.includes(String(phone.status || '').toUpperCase())) {
      const reasons = blocked.flatMap((x) => (x.errors || []).map((er) => `${x.entity_type} ${er.error_code}: ${er.error_description}`));
      await failover(blocked.length ? `${blocked.map((x) => x.entity_type).join(', ')} BLOCKED` : `number ${phone.status || top}`,
        { trigger: why, status: phone.status, reasons });
      return { decided: 'failover', reasons };
    }

    // Quality: RED pauses templates for a week; YELLOW is told.
    const q = String(phone.quality_rating || '').toUpperCase();
    const last = String(await settings.get('wa_guard_quality', '') || '');
    if (q && q !== last) {
      await set('wa_guard_quality', q);
      if (q === 'RED') {
        await set('whatsapp_templates_paused_until', new Date(Date.now() + 7 * 864e5).toISOString());
        settings.refresh();
        await tellOwner({ key: 'whatsapp_quality_red', title: '🔴 WhatsApp quality LOW — templates paused 7 days',
          text: 'Meta rated GaadiPe\'s number Low (blocks or reports). The failsafe paused all templates for 7 days; replies still go. Pause the WhatsApp ad and send nothing promotional.' });
      } else if (q === 'YELLOW') {
        await tellOwner({ key: 'whatsapp_quality_yellow', severity: 'warning', title: '🟡 WhatsApp quality Medium',
          text: 'Meta lowered GaadiPe\'s number to Medium. Pause marketing and offers; keep replies and alerts only.' });
      }
    }
    return { decided: 'ok', status: phone.status, quality: q || 'UNKNOWN', can_send: top || null };
  } finally {
    running = false;
  }
}

/** A webhook said something about the account: check now instead of waiting for the timer. */
function fromWebhook(field) {
  setTimeout(() => check(`webhook ${field}`).catch((e) => console.error('[waGuard] %s', e.message)), 2000).unref?.();
}

function start(everySeconds = 600) {
  const tick = () => check('timer').then((r) => { if (r?.decided && r.decided !== 'ok') console.log('[waGuard]', JSON.stringify(r)); })
    .catch((e) => console.error('[waGuard]', e.message));
  setTimeout(tick, 90 * 1000).unref?.();
  setInterval(tick, everySeconds * 1000).unref();
  console.log(`  WhatsApp failsafe: every ${everySeconds}s`);
}

module.exports = { start, check, fromWebhook, failover };
