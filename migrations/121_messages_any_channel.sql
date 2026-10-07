-- 121_messages_any_channel.sql — one account, any channel (user, 2026-10-07:
-- "in future, switching between web & WhatsApp, they agree to accept
-- messages / notifications").
--
-- GaadiPe runs on WhatsApp and on gaadipe.in, and the WhatsApp account was
-- disabled on 6 Oct 2026 — customers moved to the website overnight. The
-- Terms clause from 062 spoke of WhatsApp alone. It now covers the website,
-- WhatsApp, SMS and email together, separates SERVICE messages (part of what
-- they use) from PROMOTIONAL ones (occasional, stoppable any time), and says
-- that if one channel is unavailable another may be used.
--
-- VERSION 4.1 on purpose: the bot compares the highest policy version with the
-- one each person agreed to and asks again when they differ, so everyone
-- agrees to this wording before their next WhatsApp check; the website records
-- the version at every sign-in.

UPDATE terms_and_conditions
   SET title = 'Messages from GaadiPe — Website, WhatsApp, SMS and Email',
       description = 'GaadiPe is offered on WhatsApp and on our website gaadipe.in. Your mobile number is your one GaadiPe account on both: your checks, reports, payments and alerts are the same wherever you use us, and you may move between them at any time. '
         || 'By accepting these Terms, on either, you agree that GaadiPe may send you SERVICE messages — sign-in codes, replies, receipts, your reports, and the alerts and reminders for vehicles you check or watch — by WhatsApp, SMS or email, on the number and email you give us. If one of these is unavailable, we may use another so that you still receive what you asked for. '
         || 'We may also send you occasional PROMOTIONAL messages about GaadiPe, such as tips, new features or offers. You can stop promotional messages at any time — reply STOP on WhatsApp, or write to support@gaadipe.in — and we will stop them on every channel; service messages for things you have asked for continue until you close your account. '
         || 'We do not sell, rent or share your mobile number or email.',
       version = '4.1',
       effective_from = CURRENT_DATE,
       modified_at = now()
 WHERE title IN ('Messages from GaadiPe on WhatsApp', 'We Do Not Message You First',
                 'Messages from GaadiPe — Website, WhatsApp, SMS and Email');

INSERT INTO privacy_policy (id, title, description, display_order, is_active, version, effective_from)
SELECT m.nid, 'One Account Across Website, WhatsApp, SMS and Email',
       'We identify you by your mobile number, whether you use GaadiPe on WhatsApp or on gaadipe.in, so your history is one account. To send you sign-in codes and service messages we use WhatsApp (Meta), an Indian SMS provider registered on the Government DLT system, and email, and we share with them only your number or email and the message itself. Your choice to stop promotional messages applies to all of these.',
       m.nord, true, '1.4', CURRENT_DATE
  FROM (SELECT coalesce(max(id), 0) + 1 AS nid, coalesce(max(display_order), 0) + 1 AS nord FROM privacy_policy) m
 WHERE NOT EXISTS (SELECT 1 FROM privacy_policy WHERE title = 'One Account Across Website, WhatsApp, SMS and Email');
