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
 * Inbound messages are recorded first and answered second, so a message is
 * never lost because the reply failed. Replies are gated on
 * WHATSAPP_REPLY_ENABLED, which stays off until a flow is worth showing people.
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
const flow = require('../whatsapp/flow');
const send = require('../whatsapp/send');
const blocks = require('../admin/blocks');
const customers = require('../vehicle/store');
const db = require('../db');

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
          // EVERYONE WHO WRITES IS A CUSTOMER (user, 2026-09-25). A users row
          // used to appear only at a vehicle check or a payment, so the admin
          // panel — Customers, Home, counts — could not see someone who said
          // Hi and stopped. Now the first message creates it (channel
          // whatsapp) and every message moves last_seen_at, and the session is
          // tied to it. Failure here must never cost the reply.
          await customers.upsertUser(rec.mobile, { name: contact?.profile?.name, waId: m.from })
            .then((u) => u && db.query(
              `UPDATE whatsapp_sessions SET user_id = $2 WHERE mobile = $1 AND user_id IS DISTINCT FROM $2`,
              [rec.mobile, u.id]))
            .catch((e) => console.error('[wa] could not record customer %s: %s', rec.mobile, e.message));
        }
        // Testing guard: a number outside WHATSAPP_ALLOWED_RECIPIENTS is recorded
        // above but never moved through the flow, so its session state stays
        // untouched for when the bot opens to everyone.
        // Blocked numbers are still RECORDED — a blocked number that abuses the
        // service is exactly the one whose messages may be needed later — but
        // nothing is ever said back to them.
        if (rec && await blocks.isBlocked('mobile', rec.mobile)) {
          console.log('[wa] %s is blocked — recorded, not answered', rec.mobile);
          continue;
        }
        if (rec && wa.replyEnabled && !send.allowed(rec.mobile)) {
          console.log('[wa] %s not in allowed recipients — recorded, not answered', rec.mobile);
          continue;
        }
        if (rec && wa.replyEnabled) {
          // One person's bad message must not stop the rest of the batch.
          await flow.handle(rec.session, m, rec.mobile)
            .catch(e => console.error('[wa] flow failed for %s: %s', rec.mobile, e.message));
        }
      }
    }
  }
}

module.exports = router;
