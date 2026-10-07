-- 122_rcs_and_promo_optin.sql (user, 2026-10-07): promotional messages get
-- their own OPT-IN — an unticked box at sign-in and a switch in Profile, the
-- exact words and the time recorded (DPDP). Service messages stay covered by
-- the Terms. (RCS was planned with it, but Fast2SMS approves an RCS brand only
-- from 1 lakh messages a month, so the wording names no RCS.)
--
-- VERSION 4.2: the Terms now say promotions need the opt-in.

ALTER TABLE users ADD COLUMN IF NOT EXISTS promo_consent_at           timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS promo_consent_text         text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS promo_consent_withdrawn_at timestamptz;

UPDATE terms_and_conditions
   SET title = 'Messages from GaadiPe — Website, WhatsApp, SMS and Email',
       description = 'GaadiPe is offered on our website gaadipe.in and on messaging channels. Your mobile number is your one GaadiPe account everywhere: your checks, reports, payments and alerts are the same wherever you use us, and you may move between them at any time. '
         || 'By accepting these Terms you agree that GaadiPe may send you SERVICE messages — sign-in codes, replies, receipts, your reports, and the alerts and reminders for vehicles you check or watch — by WhatsApp, SMS or email, on the number and email you give us. If one of these is unavailable, we may use another so that you still receive what you asked for. '
         || 'PROMOTIONAL messages — tips, new features and offers — are sent only if you opt in, by ticking the box when you sign in or in your Profile, and only occasionally. You can withdraw that at any time in your Profile, by replying STOP, or by writing to support@gaadipe.in, and we will stop them on every channel. Service messages for things you have asked for continue until you close your account. '
         || 'We do not sell, rent or share your mobile number or email.',
       version = '4.2',
       effective_from = CURRENT_DATE,
       modified_at = now()
 WHERE title IN ('Messages from GaadiPe on WhatsApp', 'We Do Not Message You First',
                 'Messages from GaadiPe — Website, WhatsApp, SMS and Email');

UPDATE privacy_policy
   SET description = 'We identify you by your mobile number on gaadipe.in and on every messaging channel, so your history is one account. To send you sign-in codes and service messages we use WhatsApp (Meta), an SMS provider registered on the Government DLT system, and email, and we share with them only your number or email and the message itself. Promotional messages are sent only if you opted in; withdrawing applies to all of these channels.',
       version = '1.5',
       effective_from = CURRENT_DATE,
       modified_at = now()
 WHERE title = 'One Account Across Website, WhatsApp, SMS and Email';
