/**
 * src/util/sms.js — one door for text messages.
 *
 * THE PROVIDER IS A SETTING, NOT A DEPENDENCY. India needs a DLT-registered
 * sender and template whichever provider is used, and the choice between MSG91,
 * Twilio and the next one is a commercial decision that should not require a
 * code change anywhere but here.
 *
 * WITH NO PROVIDER CONFIGURED the message is logged and reported as sent, so
 * the whole sign-in flow can be built and tested before an account exists.
 * That is a development convenience and nothing else: config.validate() refuses
 * to boot a production server whose site login has no way to deliver a code.
 */

const PROVIDER = String(process.env.SMS_PROVIDER || '').toLowerCase();
const SENDER = process.env.SMS_SENDER_ID || 'GAADPE';

const configured = () => Boolean(PROVIDER);

/*
 * FAST2SMS, DLT route (user, 2026-09-18) — the same sender (SRVRPE) and the same
 * registered OTP template (FAST2SMS_DLT_MESSAGE_ID) the Pravesha service uses.
 * That template has three placeholders, filled in order: the code, the product
 * name, and how long the code lasts ("10 minutes"). A different count is
 * rejected by the operator and the SMS simply never arrives.
 *
 * The key goes in the `authorization` HEADER: sent in the POST body Fast2SMS
 * answers 401, which reads exactly like a wrong key.
 */
/*
 * THE GOVERNMENT TEMPLATE ID → FAST2SMS'S MESSAGE ID (user, 2026-10-15: "I need to input those 3
 * params, that's it — the platform must take care of this SMS"). The DLT portal names a template by
 * a 19-digit id (1277179182202755003); Fast2SMS's DLT route wants its own Message ID for it. Given
 * the long one, it is looked up once in Fast2SMS's DLT Manager (a read-only GET) and remembered;
 * if that lookup fails, the id goes as it was given — never worse than before.
 */
const messageIds = new Map();
async function fast2smsMessageId(id) {
  const s = String(id || '').trim();
  if (!/^\d{15,25}$/.test(s)) return s;                       // already Fast2SMS's own (short) id
  if (messageIds.has(s)) return messageIds.get(s);
  const key = process.env.FAST2SMSAPIKEY || process.env.FAST2SMS_API_KEY || '';
  if (!key) return s;
  try {
    const res = await fetch(`https://www.fast2sms.com/dev/dlt_manager?type=template&authorization=${encodeURIComponent(key)}`,
      { headers: { authorization: key }, signal: AbortSignal.timeout(10000) });
    const body = await res.json().catch(() => null);
    // Whatever the nesting, the entry that carries this DLT template id also carries its message id.
    let found = null;
    const walk = (x) => {
      if (found || !x || typeof x !== 'object') return;
      if (!Array.isArray(x) && Object.values(x).some((v) => String(v).trim() === s)) {
        const k = Object.keys(x).find((n) => /^message_?id$/i.test(n)) || Object.keys(x).find((n) => /^(msg_?id|id)$/i.test(n));
        if (k && String(x[k]).trim() && String(x[k]).trim() !== s) { found = String(x[k]).trim(); return; }
      }
      Object.values(x).forEach(walk);
    };
    walk(body);
    if (found) { messageIds.set(s, found); console.log('[sms] DLT template %s is Fast2SMS message %s', s, found); return found; }
    console.warn('[sms] DLT template %s not found in the Fast2SMS DLT Manager — sending with it as given', s);
  } catch (e) {
    console.warn('[sms] Fast2SMS DLT Manager lookup failed (%s) — sending with %s as given', e.message, s);
  }
  return s;
}

async function sendViaFast2sms({ mobile, variables, messageId: givenId = null, values: givenValues = null, sender: givenSender = null }) {
  const key = process.env.FAST2SMSAPIKEY || process.env.FAST2SMS_API_KEY || '';
  // A promotional template goes from the promotional header (2026-10-13); everything else from the usual one.
  const sender = givenSender || process.env.FAST2SMS_SENDER_ID || '';
  // The OTP template unless another approved template (alerts, 2026-10-10) is named.
  const messageId = givenId || process.env.FAST2SMS_DLT_MESSAGE_ID || '';
  if (!key || !sender || !messageId) {
    throw new Error('Fast2SMS is not configured (FAST2SMSAPIKEY, FAST2SMS_SENDER_ID, FAST2SMS_DLT_MESSAGE_ID)');
  }
  const values = (givenValues || [variables.code, variables.brand || 'GaadiPe', `${variables.minutes || 10} minutes`])
    .map((v) => String(v).replace(/\|/g, ' ')).join('|');
  const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      route: process.env.FAST2SMS_ROUTE || 'dlt',
      sender_id: sender,
      message: messageId,
      variables_values: values,
      numbers: mobile,
      flash: '0',
      ...(process.env.FAST2SMS_ENTITY_ID ? { entity_id: process.env.FAST2SMS_ENTITY_ID } : {}),
    }).toString(),
    signal: AbortSignal.timeout(12000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !(body.return === true || body.return === 'true')) {
    const why = Array.isArray(body.message) ? body.message.join('; ') : body.message || `HTTP ${res.status}`;
    throw new Error(`Fast2SMS refused: ${why}`);
  }
  return { id: body.request_id || null };
}

/**
 * MSG91's flow API: a template registered with DLT, variables filled in.
 * The template id, not the message text, is what is registered — sending text
 * that does not match a registered template is how SMS silently stops arriving.
 */
async function sendViaMsg91({ mobile, variables, templateId }) {
  const res = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: {
      authkey: process.env.MSG91_AUTH_KEY || '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      template_id: templateId || process.env.MSG91_OTP_TEMPLATE_ID,
      sender: SENDER,
      short_url: '0',
      recipients: [{ mobiles: `91${mobile}`, ...variables }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || String(body.type).toLowerCase() === 'error') {
    throw new Error(body.message || `MSG91 HTTP ${res.status}`);
  }
  return { id: body.request_id || null };
}

/** Twilio, for completeness: plain text to an E.164 number. */
async function sendViaTwilio({ mobile, text }) {
  const sid = process.env.TWILIO_ACCOUNT_SID || '';
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN || ''}`).toString('base64');
  const form = new URLSearchParams({
    To: `+91${mobile}`,
    From: process.env.TWILIO_FROM || '',
    Body: text,
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Twilio HTTP ${res.status}`);
  return { id: body.sid || null };
}

/**
 * Send a text. Never throws: a customer who cannot be told their code sees a
 * message saying so, and the server keeps running.
 *
 * @param {string} mobile     ten digits
 * @param {string} text       the whole message, for providers that take text
 * @param {object} variables  template variables, for providers that take those
 */
/*
 * THE RECORD (migration 155, user 2026-10-10: "SMS status for every user"). Every
 * SMS, whatever became of it, is written to notify_log for the web admin's SMS &
 * notifications page. A sign-in code is logged as 'otp' with no content. Never throws.
 */
async function logSms({ kind, mobile, out, values = null, queueId = null, adminId = null }) {
  try {
    const db = require('../db');
    const m = String(mobile || '').replace(/\D/g, '').slice(-10);
    const u = m ? await db.one(`SELECT id FROM users WHERE right(regexp_replace(mobile, '\\D', '', 'g'), 10) = $1 LIMIT 1`, [m]) : null;
    const status = out.simulated ? 'simulated' : out.ok ? 'sent' : out.skipped ? 'skipped' : 'failed';
    await db.query(
      `INSERT INTO notify_log (channel, kind, user_id, mobile, status, error, provider_id, preview, queue_id, admin_id)
            VALUES ('sms', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [kind, u?.id || null, m || null, status, out.ok ? null : String(out.error || '').slice(0, 300) || null,
        out.id || null, values && kind !== 'otp' ? values.join(' | ').slice(0, 300) : null, queueId, adminId]);
  } catch (e) { console.error('[sms] log failed: %s', e.message); }
}

async function send(mobile, text, { variables = {}, templateId = null } = {}) {
  const m = String(mobile || '').replace(/\D/g, '').slice(-10);
  if (m.length !== 10) return { ok: false, error: 'bad_mobile' };

  if (!configured()) {
    // Never the text: it carries the code.
    console.warn('[sms] no SMS_PROVIDER set — would have sent a message to ••••%s', m.slice(-4));
    const out = { ok: true, simulated: true };
    await logSms({ kind: 'otp', mobile: m, out });
    return out;
  }

  try {
    const out = PROVIDER === 'fast2sms' ? await sendViaFast2sms({ mobile: m, variables })
      : PROVIDER === 'msg91' ? await sendViaMsg91({ mobile: m, variables, templateId })
      : PROVIDER === 'twilio' ? await sendViaTwilio({ mobile: m, text })
      : (() => { throw new Error(`Unknown SMS_PROVIDER "${PROVIDER}"`); })();
    console.log('[sms] sent to ••••%s via %s', m.slice(-4), PROVIDER);
    await logSms({ kind: 'otp', mobile: m, out: { ok: true, id: out.id } });
    return { ok: true, id: out.id };
  } catch (e) {
    console.error('[sms] send to ••••%s failed: %s', m.slice(-4), e.message);
    await logSms({ kind: 'otp', mobile: m, out: { ok: false, error: e.message } });
    return { ok: false, error: e.message };
  }
}

/*
 * THE OTHER SMS — ALERTS, REMINDERS, NOTICES, OFFERS (user, 2026-10-10: "SMS and
 * web based"). Each kind is its own DLT-approved template; its Fast2SMS message
 * id is a setting (sms_tpl_<kind>), empty until the user has it approved, and
 * then nothing is sent of that kind. sms_alerts_enabled is the master switch.
 *
 *   expiry       [document, vehicle, date]       "Insurance for KA01AB1234 expires on 12 Oct 2026"
 *   challan      [vehicle, what]                 "New challan found on KA01AB1234: 1 pending, Rs 500"
 *   monitor_end  [vehicle, date]                 "Monitoring for KA01AB1234 ends on 24 Oct 2026"
 *   service      []                              the one-time "GaadiPe is now on gaadipe.in" notice
 *   offers       [tip]                           only to people who opted in (promotional route)
 *
 * DLT allows about 30 characters per variable, so each is cut to fit. Never sent
 * to a deactivated account or a blocked number. Never throws.
 */
// 'manual' (2026-10-10): the web admin's own SMS to chosen customers — a placeholder template until approved.
// 'status' (2026-10-10): the status update on the cadence in jobs/watch.js — [vehicle, short status].
// 'promo' (2026-10-13): the admin's promotional broadcast — 3 values, opted-in customers only (admin/smsBroadcast.js).
const KINDS = ['expiry', 'challan', 'monitor_end', 'service', 'offers', 'manual', 'status', 'promo'];
const PROMOTIONAL = ['offers', 'promo'];
async function sendTemplate(kind, mobile, values = [], meta = {}) {
  const out = await sendTemplateRaw(kind, mobile, values, meta);
  await logSms({ kind, mobile, out, values: values.map((v) => String(v ?? '')), queueId: meta.queueId || null, adminId: meta.adminId || null });
  return out;
}
async function sendTemplateRaw(kind, mobile, values = [], meta = {}) {
  if (!KINDS.includes(kind)) return { ok: false, error: 'unknown_kind' };
  const settings = require('./settings');
  // The master switch is for the automatic SMS; a manual or promotional send from the admin is a decision of its own.
  // 'service' too (2026-10-13): only ever sent by hand, from the admin's SMS broadcast or the web admin.
  if (!['manual', 'promo', 'service'].includes(kind) && !(await settings.bool('sms_alerts_enabled', false))) return { ok: false, skipped: true, error: 'sms_alerts_off' };
  /* A broadcast SMS carries its own template (sms_templates, migration 187, 2026-10-15): its
     message id and header; everything else uses the one template Settings name for its kind. */
  const tpl = meta.templateId
    ? await require('../db').one(`SELECT dlt_id, sender, kind FROM sms_templates WHERE id = $1`, [meta.templateId]).catch(() => null)
    : null;
  if (meta.templateId && !tpl) return { ok: false, skipped: true, error: 'its SMS template was deleted' };
  const messageId = tpl ? tpl.dlt_id : String(await settings.get(`sms_tpl_${kind}`, '') || '').trim();
  if (!messageId) return { ok: false, skipped: true, error: `no approved template for ${kind}` };
  const m = String(mobile || '').replace(/\D/g, '').slice(-10);
  if (m.length !== 10) return { ok: false, error: 'bad_mobile' };
  if (await require('../admin/blocks').isBlocked('mobile', m).catch(() => false)) return { ok: false, error: 'blocked' };
  /*
   * PROMOTIONAL: only 10 am – 9 pm IST (TRAI), and only to someone who opted in to
   * offers and newsletters and did not withdraw it (Terms 4.2) — checked here, at
   * the one door every SMS leaves through, whoever queued it (2026-10-13).
   */
  if (PROMOTIONAL.includes(kind)) {
    const h = new Date(Date.now() + 5.5 * 3600e3).getUTCHours();
    if (h < 10 || h >= 21) return { ok: false, skipped: true, error: 'outside 10 am - 9 pm (promotional)' };
    // A test (scripts/test-sms.js, 2026-10-15) may skip the opt-in for GaadiPe's own internal numbers only.
    const ok = await require('../db').one(
      `SELECT 1 FROM users WHERE right(regexp_replace(mobile, '\\D', '', 'g'), 10) = $1
          AND ((promo_consent_at IS NOT NULL AND promo_consent_withdrawn_at IS NULL) OR ($2 AND is_internal))
          AND deactivated_at IS NULL LIMIT 1`, [m, Boolean(meta.test)]).catch(() => null);
    if (!ok) return { ok: false, skipped: true, error: 'not opted in to offers' };
  }
  /* THE ALERT TEMPLATES TAKE {#alphanumeric#} VALUES (user, 2026-10-21: gp_expiry_alert_v1,
     gp_challan_alert_v1, gp_vehicle_status_v1, gp_monitor_end_v1 raised as Service Inferred). A comma,
     semicolon or "+" there can get the SMS rejected, so for these kinds a value keeps only letters,
     digits, spaces, "." and "-", lists joined by "and". Broadcasts (links, own wording) are left alone. */
  const ALERT = ['expiry', 'challan', 'status', 'monitor_end'];
  const plain = (v) => (ALERT.includes(kind)
    ? v.replace(/\s*[,;&]\s*/g, ' and ').replace(/\s*\+\s*(\d+)/g, ' and $1 more').replace(/[^A-Za-z0-9 .\-]/g, '').replace(/\s+/g, ' ').trim()
    : v);
  // At most 30 characters, cut at a whole word ("challans pending", not "challans pendi").
  const fit = (v) => {
    if (v.length <= 30) return v;
    const at = v.slice(0, 31).lastIndexOf(' ');
    return (at > 0 ? v.slice(0, at) : v.slice(0, 30)).replace(/\s+and$/, '').trim();
  };
  const cut = values.map((v) => fit(plain(String(v ?? '').replace(/\s+/g, ' ').trim())));
  if (!configured()) {
    console.warn('[sms] no SMS_PROVIDER set — would have sent %s to ••••%s', kind, m.slice(-4));
    return { ok: true, simulated: true };
  }
  try {
    if (PROVIDER !== 'fast2sms') throw new Error(`template SMS is set up for Fast2SMS only (provider ${PROVIDER})`);
    const promoSender = tpl?.sender || (PROMOTIONAL.includes(kind)
      ? (String(await settings.get('sms_promo_sender_id', '') || '').trim() || process.env.FAST2SMS_PROMO_SENDER_ID || null) : null);
    if (PROMOTIONAL.includes(kind) && !promoSender) throw new Error('no promotional sender id (Settings sms_promo_sender_id)');
    const out = await sendViaFast2sms({ mobile: m, messageId: await fast2smsMessageId(messageId), values: cut, sender: promoSender });
    console.log('[sms] %s sent to ••••%s', kind, m.slice(-4));
    return { ok: true, id: out.id };
  } catch (e) {
    console.error('[sms] %s to ••••%s failed: %s', kind, m.slice(-4), e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { send, sendTemplate, configured, PROVIDER, KINDS };
