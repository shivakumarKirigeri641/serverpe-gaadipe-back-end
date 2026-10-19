/**
 * src/whatsapp/monitorAlert.js — the monitoring alert template and its three
 * buttons (user, 2026-10-12).
 *
 * gp_monitoringalert_en_v1 (migration 160): header "Monitoring alert from GaadiPe",
 *   1 name, 2 vehicle, 3 document, 4 expiry date, 5 status
 * and three quick replies, in this order:
 *   0 "Thanks for remembering"  a thank-you back, nothing changes
 *   1 "Check vehicle"           the vehicle opens in the chat (flow.js openVehicle:
 *                               the report they bought, or a fresh check)
 *   2 "Pause this alert"        asks first ("Yes, pause" / "No, keep alerts"); yes
 *                               holds that alert back alert_pause_days (30);
 *                               "Resume alerts" ends every pause at once
 *
 * Every button carries a payload "mon|<t|c|p>|<vehicle id>|<exp|chg>|<docs>":
 * exp = a document warning (jobs/expiryWatch.js), docs its keys joined by ",";
 * chg = a change, daily status or challan update (jobs/watch.js,
 * jobs/challanFollowup.js), paused for the whole vehicle ('all').
 * A tap is a reply, so it opens the free 24-hour window too.
 */

const db = require('../db');
const settings = require('../util/settings');
const send = require('./send');

/*
 * Every reply here ends with reply buttons (user, 2026-10-12: "incorporate 1 or 2
 * or 3 replies to engage user"); plain text only if they cannot go. The ids are
 * flow.js's BTN values (check_another, menu, my_reports).
 */
async function say(mobile, body, list) {
  const out = await send.buttons(mobile, body, list).catch(() => ({ ok: false }));
  return out.ok ? out : send.text(mobile, body);
}
const B = {
  check: { id: 'check_another', title: 'Check vehicle' },
  menu: { id: 'menu', title: 'Menu' },
  reports: { id: 'my_reports', title: 'My vehicle reports' },
  resume: { id: 'mon_resume', title: 'Resume alerts' },
};

const NAME = 'gp_monitoringalert_en_v1';
const KEYS = ['insurance', 'pucc', 'tax', 'fitness', 'permit'];   // jobs/expiryWatch.js DOCUMENTS
const LABEL = { insurance: 'Insurance', pucc: 'PUC', tax: 'Road tax', fitness: 'Fitness', permit: 'Permit' };

// Meta refuses an empty value (and a newline, which send.template takes out).
const filled = (v, fallback = 'Not applicable') => String(v ?? '').trim() || fallback;

/**
 * Send the alert. `kind` is 'exp' for a document warning (docs = its keys) and
 * 'chg' for anything else. `settingKey` names the app_settings row holding the
 * template's name, so it can be switched without a deploy.
 */
async function sendAlert(mobile, { name, vehicle, vehicleId, document, expiry, status,
                                   kind = 'chg', docs = ['all'], settingKey = 'wa_template_monitoring' }) {
  const tpl = await settings.get(settingKey, NAME);
  const tail = `${vehicleId || 0}|${kind}|${(docs.length ? docs : ['all']).join(',')}`;
  const out = await send.template(mobile, tpl,
    [filled(name, 'there'), filled(vehicle), filled(document), filled(expiry), filled(status).slice(0, 900)],
    { language: await settings.get('wa_template_language', 'en'),
      buttons: [`mon|t|${tail}`, `mon|c|${tail}`, `mon|p|${tail}`] });
  return { ...out, template: tpl };
}

/*
 * INSIDE THE 24-HOUR WINDOW (user, 2026-10-13: "an unapproved template can't go — create
 * one the same and reply within 24 hours?"). No template is needed there, so the alert
 * goes as a free message laid out like gp_monitoringalert_en_v1, with the same three
 * buttons — their ids are the template's payloads, so a tap is handled the same way.
 * Plain text if the buttons cannot go (a body over 1024 characters).
 */
async function sendInWindow(mobile, { name, vehicle, vehicleId, document, expiry, status, kind = 'chg', docs = ['all'], extra = '' }) {
  const body = [
    '🔔 *Monitoring alert from GaadiPe*', '',
    `Hello *${filled(name, 'there')}*,`, '',
    `Monitoring alert for your vehicle: *${filled(vehicle)}*`, '',
    `Document: *${filled(document)}*`,
    `Expiry Date: *${filled(expiry)}*`,
    `Status: *${filled(status)}*`,
    ...(extra ? ['', extra] : []),
    // No "fines" warning (2026-10-19, SCAM strikes): say what GaadiPe is, and what it never does.
    '', '_A reminder you asked GaadiPe for. GaadiPe never collects payments for challans or documents._',
  ].join('\n');
  const tail = `${vehicleId || 0}|${kind}|${(docs.length ? docs : ['all']).join(',')}`;
  // Reply buttons hold 20 characters (a template's hold 25): "Thanks for remembering" is 22.
  const out = body.length <= 1024
    ? await send.buttons(mobile, body, [{ id: `mon|t|${tail}`, title: 'Thanks for reminding' },
      { id: `mon|c|${tail}`, title: 'Check vehicle' }, { id: `mon|p|${tail}`, title: 'Pause this alert' }]).catch(() => ({ ok: false }))
    : { ok: false };
  return out.ok ? out : send.text(mobile, body);
}

/* ───────────────────────────────────────────────────────── the taps ── */

// t thanks · c check · p pause (asks first) · py yes, pause · pn no, keep alerts
function parse(payload) {
  const [tag, action, vid, kind, docs] = String(payload || '').split('|');
  if (tag !== 'mon' || !['t', 'c', 'p', 'py', 'pn'].includes(action)) return null;
  const list = String(docs || 'all').split(',').filter((d) => d === 'all' || KEYS.includes(d));
  return { action, vehicleId: Number(vid) || null, kind: kind === 'exp' ? 'exp' : 'chg', docs: list.length ? list : ['all'] };
}

/*
 * TYPED, NOT TAPPED: "pause this alert" written by hand, or a tap that came
 * back without its payload — it is about the last document warning, if one
 * went out in the past week.
 */
async function lastWarning(userId) {
  const { rows } = await db.query(
    `SELECT vehicle_id, array_agg(DISTINCT document) AS docs
       FROM expiry_warnings
      WHERE user_id = $1 AND created_at > now() - interval '7 days'
        AND vehicle_id = (SELECT vehicle_id FROM expiry_warnings WHERE user_id = $1
                           ORDER BY created_at DESC LIMIT 1)
      GROUP BY vehicle_id`, [userId]);
  return rows[0] ? { vehicleId: Number(rows[0].vehicle_id), kind: 'exp', docs: rows[0].docs } : null;
}

const BUTTON = { t: /^thanks for (remembering|reminding)$/i, c: /^check vehicle$/i, p: /^pause this alert$/i };
const PAUSE_RE = /^(pause (this )?alerts?|pause)\s*[.!]?$/i;
const RESUME_RE = /^(resume|resume alerts?|unpause( alerts?)?)\s*[.!]?$/i;

/** Is this alert paused right now? doc is a DOCUMENTS key, or 'all' for the vehicle's change alerts. */
async function snoozed(userId, vehicleId, doc = 'all') {
  return Boolean(await db.one(
    `SELECT 1 FROM alert_snoozes WHERE user_id = $1 AND vehicle_id = $2
        AND document IN ($3, 'all') AND until > now() LIMIT 1`, [userId, vehicleId, doc]));
}

/**
 * A tap on one of the three buttons, or "pause alerts" / "resume alerts" typed.
 * Returns null when the message was not one of these, else
 * { step, open } — open is a vehicle number for flow.js to open, or 'list'
 * for "which vehicle?" when the alert covered several.
 */
async function handleTap(mobile, intent) {
  const text = String(intent.text || '').trim();
  let tap = intent.kind === 'button' ? parse(intent.id) : null;
  // A template tap whose payload was lost (Meta then sends the button's words as
  // the payload) still says which button it was — never the bot's own buttons,
  // which carry ids of their own ("Check vehicle" is check_another there).
  const lostPayload = intent.kind === 'button' && (!intent.id || intent.id === intent.text);
  const action = tap?.action
    || (lostPayload && Object.keys(BUTTON).find((k) => BUTTON[k].test(text)))
    || (PAUSE_RE.test(text) ? 'p' : RESUME_RE.test(text) ? 'r' : null);
  if (!action) return null;

  const user = await db.one(`SELECT id FROM users WHERE mobile = $1`, [mobile]);
  if (!user) return null;

  if (action === 'r') {
    const { rowCount } = await db.query(`DELETE FROM alert_snoozes WHERE user_id = $1 AND until > now()`, [user.id]);
    await say(mobile, rowCount
      ? '✅ Alerts are back on — we will tell you before anything expires or a new challan appears.'
      : 'Your alerts are already on ✅', [B.check, B.reports, B.menu]);
    return { step: 'alert_resumed' };
  }

  if (!tap?.vehicleId && action === 'p') tap = await lastWarning(user.id);
  let reg = null;
  if (tap?.vehicleId) {
    // Only a vehicle on this customer's own list.
    const own = await db.one(
      `SELECT v.reg_no FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
        WHERE uv.user_id = $1 AND uv.vehicle_id = $2 LIMIT 1`, [user.id, tap.vehicleId]);
    if (!own) return null;
    reg = own.reg_no;
  }

  if (action === 't') {
    // "See it now" opens this same vehicle, as the alert's own Check vehicle does.
    await say(mobile, `You're welcome 🙏 — we will keep watching${reg ? ` *${reg}*` : ' your vehicles'} `
      + 'and tell you before anything expires or a new challan appears.',
    [reg ? { id: `mon|c|${tap.vehicleId}|chg|all`, title: `See ${reg}`.slice(0, 20) } : B.check, B.reports, B.menu]);
    return { step: 'alert_thanks' };
  }

  if (action === 'c') return { step: 'alert_check', open: reg || 'list' };

  if (action === 'pn') {
    await say(mobile, `👍 Alerts stay on — we will keep watching${reg ? ` *${reg}*` : ''} for you.`,
      [reg ? { id: `mon|c|${tap.vehicleId}|chg|all`, title: `See ${reg}`.slice(0, 20) } : B.check, B.reports, B.menu]);
    return { step: 'alert_pause_cancelled' };
  }

  // "Pause this alert" (or typed "pause alerts")
  if (!reg) {
    if (intent.kind !== 'button') return null;   // typed, with no alert behind it: not ours
    await say(mobile, 'Which alert should be paused? Reply with the vehicle number and *pause*.', [B.reports, B.menu]);
    return { step: 'alert_pause_unknown' };
  }
  const days = await settings.num('alert_pause_days', 30);
  const docs = tap.kind === 'exp' && !tap.docs.includes('all') ? tap.docs : ['all'];
  const what = docs.includes('all') ? 'alerts' : `${docs.map((d) => LABEL[d] || d).join(' and ')} alerts`;

  /*
   * ASKED FIRST (user, 2026-10-12: "Are you sure you want to pause? this will stop
   * alerting you for next 30 days"). The tap has just opened the 24-hour window,
   * so reply buttons can go; only "Yes, pause" pauses.
   */
  if (action === 'p') {
    const tail = `${tap.vehicleId}|${tap.kind}|${docs.join(',')}`;
    const asked = await send.buttons(mobile,
      `Are you sure you want to pause ${what} for *${reg}*?\n\n`
      + `We will not alert you for the next *${days} days* — no WhatsApp, email, SMS or notification about it, `
      + 'even if something expires or a new challan appears.',
      [{ id: `mon|py|${tail}`, title: 'Yes, pause' }, { id: `mon|pn|${tail}`, title: 'No, keep alerts' }]);
    if (asked.ok) return { step: 'alert_pause_asked' };
    // Could not ask (should not happen inside the window): nothing is paused.
    await send.text(mobile, `Your alerts for *${reg}* are still on. To pause them, reply *pause alerts*.`);
    return { step: 'alert_pause_failed' };
  }

  // "Yes, pause"
  for (const d of docs) {
    await db.query(
      `INSERT INTO alert_snoozes (user_id, vehicle_id, document, reason, until)
       VALUES ($1, $2, $3, 'paused', now() + ($4 || ' days')::interval)`, [user.id, tap.vehicleId, d, String(days)]);
  }
  await say(mobile, `⏸️ Paused — no ${what} for *${reg}* for the next ${days} days.\n\n`
    + '_Changed your mind? Tap *Resume alerts*._', [B.resume, B.check, B.menu]);
  return { step: 'alert_paused' };
}

module.exports = { NAME, sendAlert, sendInWindow, handleTap, snoozed, parse };
