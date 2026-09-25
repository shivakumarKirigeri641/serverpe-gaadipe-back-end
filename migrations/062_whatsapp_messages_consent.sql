-- 062_whatsapp_messages_consent.sql — accepting the Terms is agreeing to
-- receive GaadiPe's WhatsApp messages; STOP ends them (user, 2026-09-25).
--
-- Part of what everyone accepts — the bot's "Agree & continue" and the
-- checkout's declaration — not a separate choice. And it says how to stop:
-- reply STOP, and GaadiPe stops messaging you until you reply START. That is
-- enforced, not just written: src/whatsapp/flow.js records it and
-- src/whatsapp/send.js refuses every template to that number.
--
-- It replaces clause "We Do Not Message You First", which stopped being true
-- when broadcasts, renewal reminders and win-back messages arrived; a Terms
-- clause the product breaks is worse than none.
--
-- VERSION 4.0 on purpose: the bot compares the highest policy version with the
-- one each person agreed to and asks again when they differ, so everyone who
-- accepted 3.0 accepts this before their next check.

/* ───────────────────────────── 1. who said STOP ───────────────────────────── */

-- NULL = receiving GaadiPe's messages, as agreed in the Terms.
-- A time = replied STOP then: no template (broadcast, reminder, alert) is sent
-- to them until they reply START. Replies to their own messages still go.
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS wa_opt_out_at timestamptz;

/* ─────────────────────────────── 2. the Terms ─────────────────────────────── */

UPDATE terms_and_conditions
   SET title = 'Messages from GaadiPe on WhatsApp',
       description = 'By accepting these Terms, you agree to receive messages from GaadiPe on WhatsApp on the number you use with us, including replies, service messages about your checks, payments, reports and alerts, and updates and offers about GaadiPe. You can stop our messages at any time by replying STOP in the chat: we will then stop messaging you, other than to reply when you write to us, until you reply START. We do not sell, rent or share your mobile number.',
       version = '4.0',
       effective_from = CURRENT_DATE,
       modified_at = now()
 WHERE title IN ('We Do Not Message You First', 'Messages from GaadiPe on WhatsApp');
