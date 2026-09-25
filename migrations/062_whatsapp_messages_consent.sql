-- 062_whatsapp_messages_consent.sql — accepting the Terms is agreeing to
-- receive GaadiPe's WhatsApp messages (user, 2026-09-25).
--
-- One line in the Terms, part of what everyone accepts — the bot's
-- "Agree & continue" and the checkout's declaration — not a separate choice.
--
-- It replaces clause "We Do Not Message You First", which stopped being true
-- when broadcasts, renewal reminders and win-back messages arrived; a Terms
-- clause the product breaks is worse than none.
--
-- VERSION 4.0 on purpose: the bot compares the highest policy version with the
-- one each person agreed to and asks again when they differ, so everyone who
-- accepted 3.0 accepts this line before their next check.

UPDATE terms_and_conditions
   SET title = 'Messages from GaadiPe on WhatsApp',
       description = 'By accepting these Terms, you agree to receive messages from GaadiPe on WhatsApp on the number you use with us, including replies, service messages about your checks, payments, reports and alerts, and updates and offers about GaadiPe. We do not sell, rent or share your mobile number.',
       version = '4.0',
       effective_from = CURRENT_DATE,
       modified_at = now()
 WHERE title = 'We Do Not Message You First';
