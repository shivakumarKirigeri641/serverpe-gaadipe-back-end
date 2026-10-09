-- 144_whatsapp_back_safely.sql (user, 2026-10-09: the WhatsApp account was restored
-- by Meta after the 6 Oct "sending spam" disable; GaadiPe goes back to WhatsApp —
-- carefully).
--
-- 1. A switch the admin controls: whatsapp_sending_enabled. It starts OFF, so this
--    deploy sends nothing; the owner turns it on in Settings when ready, and can
--    turn it off again at once. (whatsapp/send.js reads it at the one door.)
-- 2. Nothing left over from before the ban may go out when it is turned on: every
--    queued broadcast is cancelled, its waiting recipients skipped, every running
--    plan cancelled, and alerts held back for more than a day dropped (the alert
--    job works out fresh ones).
-- 3. The automatic "please agree to the Terms" nudge to people who only said Hi is
--    switched off: they hear from GaadiPe only if they write again.
-- 4. Marketing is capped: whatsapp_marketing_per_day (25) and no second marketing
--    message to the same person within whatsapp_marketing_gap_days (7).
-- 5. The Terms say how agreement and the offers opt-in work on WhatsApp.

INSERT INTO app_settings (key, value) VALUES
  ('whatsapp_sending_enabled', 'false'),
  ('nudge_enabled', 'false'),
  ('whatsapp_marketing_per_day', '25'),
  ('whatsapp_marketing_gap_days', '7')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

UPDATE whatsapp_broadcast_targets t SET status = 'skipped'
  FROM whatsapp_broadcasts b
 WHERE b.id = t.broadcast_id AND b.status = 'queued' AND t.status IN ('pending', 'failed');
UPDATE whatsapp_broadcasts SET status = 'cancelled' WHERE status = 'queued';
UPDATE broadcast_plans SET status = 'cancelled' WHERE status IN ('running', 'paused');
DELETE FROM pending_alerts WHERE sent_at IS NULL AND created_at < now() - interval '1 day';

-- Acceptance of Terms 1.3: WhatsApp's own agreement step named, as before the ban.
UPDATE terms_and_conditions
   SET description = 'By using gaadipe.in or GaadiPe on WhatsApp, or any GaadiPe service or communication channel (such as SMS or email), you agree to be bound by these Terms & Conditions. '
         || 'On WhatsApp, GaadiPe shows you these Terms, the Privacy policy and the Refund policy before your first vehicle check; tapping “Agree & continue” is your acceptance. '
         || 'On the website, tapping “Agree & check” before a free check, or signing in with your mobile number and the one-time code we send you, is your acceptance — the screen tells you so, and no separate box needs to be ticked. '
         || 'We keep a record of each acceptance: the date and time, the versions of the policies in force, and where it was given from. '
         || 'GaadiPe is operated by ServerPe App Solutions (GSTIN 29BSMPK7696H1ZT). If you do not agree with any part of these Terms, please do not use the service.',
       version = '1.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Acceptance of Terms';

-- Messages from GaadiPe 4.3: the offers opt-in can also be given on WhatsApp.
UPDATE terms_and_conditions
   SET description = replace(description,
         'by ticking the box when you sign in or in your Profile, and only occasionally.',
         'by ticking the box when you sign in, in your Profile, or by tapping “Yes” when GaadiPe asks on WhatsApp — and only occasionally.'),
       version = '4.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE id = 22 AND description LIKE '%by ticking the box when you sign in or in your Profile, and only occasionally.%';
