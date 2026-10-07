/**
 * src/channels/rcs.js — RCS MESSAGING, A PLACEHOLDER (user, 2026-10-07: "I will
 * soon include RCS messaging, make a placeholder").
 *
 * The same shape as the other channels (mail/mailer.send, util/sms.send), so the
 * broadcast screen, the alerts and the customer's preferences can already name
 * it. Nothing is sent: until a provider is chosen and its keys are in .env
 * (RCS_PROVIDER, RCS_API_KEY, RCS_SENDER_ID — names to confirm with the
 * provider) and the rcs_enabled setting is "true", send() answers
 * { ok: false, error: 'not set up' }.
 *
 * When a provider is chosen: fill in sendVia<Provider>() below, keep the answer
 * shape, and switch rcs_enabled on. Promotions must still check the customer's
 * tips & offers consent, as email does.
 */

const configured = () => Boolean(process.env.RCS_PROVIDER && process.env.RCS_API_KEY && process.env.RCS_SENDER_ID);

async function send(mobile, { text, title = null, image = null, buttons = [] } = {}) {
  void mobile; void text; void title; void image; void buttons;
  if (!configured()) return { ok: false, error: 'RCS is not set up yet (RCS_PROVIDER, RCS_API_KEY, RCS_SENDER_ID)' };
  if (String(await require('../util/settings').get('rcs_enabled', 'false')) !== 'true') return { ok: false, error: 'RCS is switched off (rcs_enabled)' };
  return { ok: false, error: `RCS provider "${process.env.RCS_PROVIDER}" is not implemented yet` };
}

module.exports = { send, configured };
