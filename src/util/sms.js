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
async function send(mobile, text, { variables = {}, templateId = null } = {}) {
  const m = String(mobile || '').replace(/\D/g, '').slice(-10);
  if (m.length !== 10) return { ok: false, error: 'bad_mobile' };

  if (!configured()) {
    console.warn('[sms] no SMS_PROVIDER set — would have sent to %s: %s', m, text);
    return { ok: true, simulated: true };
  }

  try {
    const out = PROVIDER === 'msg91' ? await sendViaMsg91({ mobile: m, variables, templateId })
      : PROVIDER === 'twilio' ? await sendViaTwilio({ mobile: m, text })
      : (() => { throw new Error(`Unknown SMS_PROVIDER "${PROVIDER}"`); })();
    console.log('[sms] sent to %s via %s', m, PROVIDER);
    return { ok: true, id: out.id };
  } catch (e) {
    console.error('[sms] send to %s failed: %s', m, e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { send, configured, PROVIDER };
