-- 139_terms_accepted_by_signing_in.sql (user, 2026-10-08): no tick box before
-- signing in any more. The chat's welcome says, under it: "By signing in, you
-- agree to GaadiPe's Terms of use, Privacy policy and Refund policy." The Terms
-- now say plainly that signing in is the acceptance, and what is recorded.
-- (Promotional messages and QuizPe messages keep their own optional ticks.)
--
-- VERSION 1.1 of "Acceptance of Terms". WhatsApp is no longer named: GaadiPe's
-- channels are the website, SMS and email.

UPDATE terms_and_conditions
   SET description = 'By using gaadipe.in, or any GaadiPe service or communication channel (such as SMS or email), you agree to be bound by these Terms & Conditions. '
         || 'When you sign in, the sign-in screen tells you: “By signing in, you agree to GaadiPe’s Terms of use, Privacy policy and Refund policy.” Signing in with your mobile number and the one-time code we send you is your acceptance of these Terms, the Privacy policy and the Refund policy, as they stand at that time — no separate box needs to be ticked. '
         || 'We keep a record of each acceptance: the date and time, the versions of the policies in force, and the device and network address you signed in from. '
         || 'GaadiPe is operated by ServerPe App Solutions (GSTIN 29BSMPK7696H1ZT). If you do not agree with any part of these Terms, please do not sign in or use the service.',
       version = '1.1',
       effective_from = CURRENT_DATE,
       modified_at = now()
 WHERE title = 'Acceptance of Terms';
