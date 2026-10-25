/**
 * src/routes/whatsapp.js
 * ---------------------------------------------------------------------------
 * Meta's webhook for +91 73531 22415 (since 2026-10-20; +91 97396 22631 before, banned).
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
const flags = require('../util/flags');
const { config } = require('../config');
const sig = require('../whatsapp/signature');
const store = require('../whatsapp/store');
const flow = require('../whatsapp/flow');
const send = require('../whatsapp/send');
const blocks = require('../admin/blocks');
const customers = require('../vehicle/store');
const track = require('../events/track');
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

const ACCOUNT_FIELDS = {
  account_update: 'Account update',
  business_capability_update: 'Business capability update',
  phone_number_quality_update: 'Phone number quality / limit',
  phone_number_name_update: 'Display name review',
  message_template_status_update: 'Template review',
  message_template_quality_update: 'Template quality',
  account_review_update: 'Account review',
  account_alerts: 'Account alert',
  // Added with the new number (2026-10-20, "all possible subscriptions to take care of"):
  business_status_update: 'Business status',          // the portfolio itself restricted / reinstated
  template_category_update: 'Template category change', // Meta moving a Utility template to Marketing
  security: 'Security change',                          // two-step PIN changed or reset on the number
};

/** Record one account-level webhook and tell the admin in plain words. */
async function accountNews(wabaId, field, value) {
  await db.query(`INSERT INTO event_log (kind, detail) VALUES ('meta_account_news', $1)`,
    [JSON.stringify({ waba: wabaId, field, value })]);
  console.log('[wa] meta %s: %s', field, JSON.stringify(value).slice(0, 300));
  // Any account news (a ban, a restriction, a quality drop…): the failsafe checks Meta now, not in 10 minutes.
  require('../jobs/waGuard').fromWebhook(field);
  const event = value.event || value.decision || value.current_limit || value.alert_type || '';
  const bits = [
    event && `Event: ${event}`,
    value.max_daily_conversation_per_phone || value.max_daily_conversations_per_business
      ? `Limit: ${value.max_daily_conversations_per_business || value.max_daily_conversation_per_phone}` : null,
    value.current_limit && `Current limit: ${value.current_limit}`,
    value.max_phone_numbers_per_business && `Phone number cap: ${value.max_phone_numbers_per_business}`,
    value.display_phone_number && `Number: ${value.display_phone_number}`,
    value.requested_verified_name && `Name: ${value.requested_verified_name}`,
    value.message_template_name && `Template: ${value.message_template_name}`,
    value.reason && `Reason: ${value.reason}`,
    value.rejection_reason && value.rejection_reason !== 'NONE' && `Reason: ${value.rejection_reason}`,
    value.alert_description && `${value.alert_description}`,
  ].filter(Boolean);
  // Template approvals are routine; everything else is worth a ping.
  const routine = field === 'message_template_status_update' && value.event === 'APPROVED';
  const bad = /FAILED|REJECT|DEFERRED|NEED_MORE_INFO|FLAGGED|DISABLED|RESTRICT|DOWNGRADE|RED|BANNED|VIOLATION/i.test(JSON.stringify(value));
  // Every strike is its own alert (2026-10-19: the SCAM strikes of 17–18 Oct were
  // swallowed as repeats of the 16 Oct one, so the ban was found days late).
  const strike = /VIOLATION|DISABLED|BANNED|RESTRICT/i.test(JSON.stringify(value));
  if (strike) bits.unshift('⛔ Account strike: stop broadcasts and ads, check Business Support Home now.');
  await require('../util/adminPing').ping({
    key: `meta_news:${field}:${event || 'x'}:${strike || !event ? Date.now() : ''}`,
    severity: strike ? 'critical' : bad ? 'warning' : 'info', source: 'meta', alert: !routine,
    title: `📣 Meta: ${ACCOUNT_FIELDS[field]}`,
    text: bits.length ? bits.join('\n') : JSON.stringify(value).slice(0, 400),
  }).catch(() => {});
}

async function handle(body) {
  if (body?.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      /*
       * META'S ACCOUNT NEWS (user, 2026-10-05): the messaging limit decision
       * (INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED / FAILED / NEED_MORE_INFO),
       * a new limit or number cap, quality changes, display name reviews,
       * template reviews. Kept in event_log and pinged to the admin — Meta
       * says the upgrade's reason only here. Needs these fields ticked in
       * App Dashboard → WhatsApp → Configuration → Webhook fields.
       */
      if (ACCOUNT_FIELDS[change.field]) {
        await accountNews(entry.id, change.field, value).catch((e) => console.error('[wa] account news:', e.message));
        continue;
      }

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
          {
            // The same message in plain words (user, 2026-10-14): what they typed or tapped.
            const act = require('../util/activity');
            const said = typeof rec.body === 'string' ? rec.body : JSON.stringify(rec.body || '');
            const words = m.type === 'text' ? `Wrote “${said.slice(0, 100)}”`
              : ['interactive', 'button'].includes(m.type) ? `Tapped “${said.slice(0, 60)}”`
                : `Sent a ${m.type}`;
            act.log('💬', words, { who: act.who(contact?.profile?.name, rec.mobile), detail: 'WhatsApp' });
          }
          // EVERYONE WHO WRITES IS A CUSTOMER (user, 2026-09-25). A users row
          // used to appear only at a vehicle check or a payment, so the admin
          // panel — Customers, Home, counts — could not see someone who said
          // Hi and stopped. Now the first message creates it (channel
          // whatsapp) and every message moves last_seen_at, and the session is
          // tied to it. Failure here must never cost the reply.
          // channel 'whatsapp' (2026-10-15): the default became 'web' on 10 Oct, so WhatsApp
          // newcomers were being counted as website customers.
          await customers.upsertUser(rec.mobile, { name: contact?.profile?.name, waId: m.from, channel: 'whatsapp' })
            .then((u) => u && db.query(
              `UPDATE whatsapp_sessions SET user_id = $2 WHERE mobile = $1 AND user_id IS DISTINCT FROM $2`,
              [rec.mobile, u.id]))
            .catch((e) => console.error('[wa] could not record customer %s: %s', rec.mobile, e.message));

          // The command center's stream (user, 2026-09-25): every message in,
          // and the first one per number as the start of the chat. Keyed by
          // Meta's message id and the number, so a redelivered webhook is one.
          const userId = (await db.one(`SELECT id FROM users WHERE mobile = $1`, [rec.mobile]).catch(() => null))?.id || null;
          const at = m.timestamp ? new Date(Number(m.timestamp) * 1000) : null;
          /* WHICH OF OUR WHATSAPP NUMBERS THEY CAME THROUGH (user, 2026-10-23: "mark every new user arriving on
             this number, so I can SMS them if WhatsApp is disabled"). Stamped once, on the first message to each
             number (user_wa_numbers, never overwritten) — so the list stays right even after the number changes
             again; users.wa_business_number is the latest one. scripts/wa-number-customers.js lists them for SMS. */
          if (userId && wa.ownNumber) {
            const ours = String(wa.ownNumber).replace(/\D/g, '');
            await db.query(`INSERT INTO user_wa_numbers (user_id, business_number) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, ours])
              .catch((e) => console.error('[wa] number stamp:', e.message));
            await db.query(`UPDATE users SET wa_business_number = $2, wa_business_number_at = now()
                             WHERE id = $1 AND wa_business_number IS DISTINCT FROM $2`, [userId, ours]).catch(() => {});
          }
          track.fire({ key: `wa_chat:${rec.mobile}`, name: 'whatsapp_chat_started', channel: 'whatsapp',
                       at, userId, mobile: rec.mobile });
          track.fire({ key: `wa_msg:${m.id}`, name: 'whatsapp_message_received', channel: 'whatsapp',
                       at, userId, mobile: rec.mobile, meta: { type: m.type } });

          // FROM A WHATSAPP AD (click-to-WhatsApp). Meta puts the ad on the
          // first message of a chat it started; it was being thrown away. It
          // becomes the chat's attribution unless the website got there first.
          if (m.referral) {
            const r = m.referral;
            const ad = { channel: 'whatsapp_ad', source_type: r.source_type || null, source_id: r.source_id || null,
                         source_url: r.source_url || null, headline: r.headline || null, ctwa_clid: r.ctwa_clid || null };
            await db.query(
              `UPDATE whatsapp_sessions SET attribution = $2::jsonb
                WHERE mobile = $1 AND attribution = '{}'::jsonb`, [rec.mobile, JSON.stringify(ad)]).catch(() => {});
            track.fire({ key: `wa_ad:${m.id}`, name: 'whatsapp_ad_clicked', channel: 'whatsapp', at, userId,
                         mobile: rec.mobile, source: 'meta_ads', campaign: r.headline || r.source_id || null, meta: ad });
            const act = require('../util/activity');
            act.log('📣', `Came from your WhatsApp ad${r.headline ? ` · “${String(r.headline).slice(0, 60)}”` : ''}`,
              { who: act.who(contact?.profile?.name, rec.mobile), detail: 'WhatsApp' });
          }
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
        if (rec && wa.replyEnabled && !(await flags.on('whatsapp_flow'))) {
          // Switched off (Feature Flags / maintenance). STOP and START are
          // honoured whatever the switch says — the Terms promise that.
          const text = String(m?.text?.body || m?.button?.text || m?.interactive?.button_reply?.title || '').trim();
          if (!/^(stop|start|unstop|subscribe|unsubscribe)$/i.test(text)) {
            const last = pausedNotice.get(rec.mobile) || 0;
            if (Date.now() - last > 30 * 60000) {
              pausedNotice.set(rec.mobile, Date.now());
              await send.text(rec.mobile, flags.MESSAGE).catch(() => {});
            }
            continue;
          }
        }
        // Meaningless messages again and again (whatsapp/junk.js, 2026-10-25): one honest pause notice, then quiet.
        if (rec && wa.replyEnabled) {
          const j = await require('../whatsapp/junk').check(rec.mobile, m).catch(() => 'answer');
          if (j === 'notice') {
            console.log('[wa] %s sent junk repeatedly — paused', rec.mobile);
            await send.text(rec.mobile, require('../whatsapp/junk').NOTICE).catch(() => {});
            require('../util/activity').whoOf(rec.mobile).then((who) => require('../util/activity')
              .log('⏸️', 'Bot paused for an hour · kept sending meaningless messages', { who, detail: 'WhatsApp' })).catch(() => {});
            continue;
          }
          if (j === 'quiet') { console.log('[wa] %s paused (junk) — recorded, not answered', rec.mobile); continue; }
        }
        if (rec && wa.replyEnabled) {
          // One person's bad message must not stop the rest of the batch.
          await flow.handle(rec.session, m, rec.mobile)
            .catch(e => console.error('[wa] flow failed for %s: %s', rec.mobile, e.message));
          // Anything they were told "busy" about earlier, answered now that they wrote again
          // (jobs/waitlist.onReturn, 2026-10-20) — after their own message, never instead of it.
          await require('../jobs/waitlist').onReturn(rec.mobile).catch(() => 0);
        }
      }
    }
  }
}

/* Who was last told the bot is paused, so they are told once per half hour. */
const pausedNotice = new Map();

module.exports = router;
module.exports._handle = handle;   // tests only
