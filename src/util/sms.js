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
async function sendViaFast2sms({ mobile, variables, messageId: givenId = null, values: givenValues = null }) {
  const key = process.env.FAST2SMSAPIKEY || process.env.FAST2SMS_API_KEY || '';
  const sender = process.env.FAST2SMS_SENDER_ID || '';
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
const KINDS = ['expiry', 'challan', 'monitor_end', 'service', 'offers', 'manual'];
async function sendTemplate(kind, mobile, values = [], meta = {}) {
  const out = await sendTemplateRaw(kind, mobile, values);
  await logSms({ kind, mobile, out, values: values.map((v) => String(v ?? '')), queueId: meta.queueId || null, adminId: meta.adminId || null });
  return out;
}
async function sendTemplateRaw(kind, mobile, values = []) {
  if (!KINDS.includes(kind)) return { ok: false, error: 'unknown_kind' };
  const settings = require('./settings');
  // The master switch is for the automatic SMS; a manual send from the web admin is a decision of its own.
  if (kind !== 'manual' && !(await settings.bool('sms_alerts_enabled', false))) return { ok: false, skipped: true, error: 'sms_alerts_off' };
  const messageId = String(await settings.get(`sms_tpl_${kind}`, '') || '').trim();
  if (!messageId) return { ok: false, skipped: true, error: `no approved template for ${kind}` };
  const m = String(mobile || '').replace(/\D/g, '').slice(-10);
  if (m.length !== 10) return { ok: false, error: 'bad_mobile' };
  if (await require('../admin/blocks').isBlocked('mobile', m).catch(() => false)) return { ok: false, error: 'blocked' };
  // Promotional SMS only 9 am – 9 pm IST (TRAI).
  if (kind === 'offers') {
    const h = new Date(Date.now() + 5.5 * 3600e3).getUTCHours();
    if (h < 9 || h >= 21) return { ok: false, skipped: true, error: 'outside 9 am - 9 pm' };
  }
  const cut = values.map((v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 30));
  if (!configured()) {
    console.warn('[sms] no SMS_PROVIDER set — would have sent %s to ••••%s', kind, m.slice(-4));
    return { ok: true, simulated: true };
  }
  try {
    if (PROVIDER !== 'fast2sms') throw new Error(`template SMS is set up for Fast2SMS only (provider ${PROVIDER})`);
    const out = await sendViaFast2sms({ mobile: m, messageId, values: cut });
    console.log('[sms] %s sent to ••••%s', kind, m.slice(-4));
    return { ok: true, id: out.id };
  } catch (e) {
    console.error('[sms] %s to ••••%s failed: %s', kind, m.slice(-4), e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { send, sendTemplate, configured, PROVIDER, KINDS };
