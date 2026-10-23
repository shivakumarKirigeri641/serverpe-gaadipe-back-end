-- 207_policies_whatsapp_again.sql (user, 2026-10-23: WhatsApp live again on the new number +91 79960 83415 —
-- "yes, update" the Terms and Privacy). The clauses from migration 197 that said GaadiPe no longer uses
-- WhatsApp now say it is offered there again, alongside the website, SMS and email — and that the account,
-- reports and alerts belong to the mobile number, so the website keeps serving if WhatsApp is unavailable.
-- Wording only; the versions stay, so nobody is asked to agree again. Matched by title (active rows).

UPDATE terms_and_conditions SET modified_at = now(),
  title = 'GaadiPe on the Website, WhatsApp, SMS and Email',
  description = 'GaadiPe is offered on our website gaadipe.in and on WhatsApp at +91 79960 83415 (business name “GaadiPe”), where you can check vehicles, buy reports and receive alerts; we also contact you by SMS, email and browser notifications on the devices where you allow them. On WhatsApp, we message you only after you write to us first, or about a service you have taken (such as alerts for a vehicle you monitor), and you can reply STOP at any time to stop our messages there. Messages or calls from any other number claiming to be GaadiPe are not from us, and GaadiPe never asks for OTPs, card or bank details, or challan payments. Your account, reports, invoices and alerts belong to your mobile number, not to any one channel: if WhatsApp or another channel is unavailable for a time, sign in on gaadipe.in with the same mobile number and everything continues there.'
 WHERE is_active AND title IN ('GaadiPe on the Website, SMS and Email', 'GaadiPe on the Website, SMS, Email and WhatsApp');

UPDATE privacy_policy SET modified_at = now(),
  title = 'Data from WhatsApp',
  description = 'When you use GaadiPe on WhatsApp, your messages and phone number are processed through Meta Platforms, which provides the WhatsApp Business service. We receive your WhatsApp number, profile name, the messages you send us (such as vehicle numbers) and delivery receipts, and, if you reached us through an advertisement, which advertisement it was. We use this only to answer you and provide the service, and keep it under the same retention rules as the rest of your data. We do not use the contents of your chats for advertising. You can reply STOP at any time to stop our messages on WhatsApp.'
 WHERE is_active AND title = 'Data from WhatsApp (until 21 October 2026)';

UPDATE privacy_policy SET modified_at = now(),
  title = 'One Account Across the Website, WhatsApp, SMS and Email',
  description = 'We identify you by your mobile number on gaadipe.in, on WhatsApp and on every channel we use, so your history is one account. To send you sign-in codes and service messages we use WhatsApp (through Meta), an SMS provider registered on the DLT system, email and browser notifications, and we share with them only your number or email and the message itself. Promotional messages are sent only if you opted in; withdrawing applies to all of these channels.'
 WHERE is_active AND title = 'One Account Across the Website, SMS and Email';
