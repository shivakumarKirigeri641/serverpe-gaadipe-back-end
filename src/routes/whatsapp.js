/**
 * src/routes/whatsapp.js
 * ---------------------------------------------------------------------------
 * Meta's webhook for +91 63632 71302.
 *
 *   GET  /serverpe/platform/gaadipe/v1/public/users/whatsapp/webhook
 *        subscribe handshake (Meta calls this once)
 *   POST same path
 *        every inbound message and delivery receipt
 *
 * This endpoint RECORDS AND DOES NOT REPLY. The conversational flow is not
 * designed yet; a half-built bot answering real customers is worse than a
 * silent number. Set WHATSAPP_REPLY_ENABLED once a handler exists.
 *
 * Two things are non-negotiable here:
 *
 *  1. ANSWER 200 IMMEDIATELY. Meta retries anything slow or non-200 with
 *     growing backoff and eventually disables the webhook. Work happens after
 *     the response, never before it.
 *
 *  2. FILTER ON phone_number_id. This number shares a WhatsApp Business Account
 *     with QuizPe, and a subscribed app receives events for BOTH numbers.
 *     Without this check GaadiPe would log — and one day answer — messages from
 *     parents doing maths quizzes.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const { config } = require('../config');
const sig = require('../whatsapp/signature');
const store = require('../whatsapp/store');

const router = express.Router();
const wa = config.whatsapp;

/* ----------------------------------------------------------- subscribe GET */
router.get('/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === wa.verifyToken) {
    console.log('[wa] webhook verified by Meta');
    // Must be the bare challenge, as text. JSON here fails the handshake.
    return res.status(200).type('text/plain').send(String(challenge));
  }
  console.warn('[wa] webhook verification refused (mode=%s, token match=%s)',
    mode, token === wa.verifyToken);
  res.sendStatus(403);
});

/* ------------------------------------------------------------- events POST */
router.post('/whatsapp/webhook', (req, res) => {
  const verdict = sig.verify(req.rawBody, req.get('x-hub-signature-256'), wa.appSecret);

  if (verdict === sig.BAD || verdict === sig.MISSING) {
    // Forged or unsigned. Meta is told 200 regardless — a 4xx would make it
    // retry a request we will never accept — but nothing is recorded.
    console.warn('[wa] rejected webhook: signature %s', verdict);
    return res.sendStatus(200);
  }
  if (verdict === sig.UNSET) {
    console.warn('[wa] WHATSAPP_APP_SECRET not set — accepting unverified webhook');
  }

  res.sendStatus(200);          // acknowledge first, then do the work
  handle(req.body).catch(e => console.error('[wa] handling failed:', e.message));
});

async function handle(body) {
  if (body?.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const to = value.metadata?.phone_number_id;

      // The QuizPe filter. See the header comment.
      if (to && wa.phoneNumberId && to !== wa.phoneNumberId) continue;

      for (const s of value.statuses || []) {
        await store.recordStatus(s);
      }

      for (const m of value.messages || []) {
        const contact = (value.contacts || []).find(c => c.wa_id === m.from);
        const rec = await store.recordInbound(m, contact);
        if (rec) {
          console.log(`[wa] in  ${rec.mobile}  ${m.type}  ${JSON.stringify(rec.body).slice(0, 80)}`);
        }
        if (wa.replyEnabled) {
          // Deliberately empty. When the flow exists it is called from here,
          // and until then the switch cannot accidentally be half-on.
        }
      }
    }
  }
}

module.exports = router;
