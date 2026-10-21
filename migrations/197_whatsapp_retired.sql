-- 197_whatsapp_retired.sql (user, 2026-10-21: "It's permanently disabled. Transfer all to the web platform").
-- Meta disabled the last WhatsApp account (WABA 1155238370163448, +91 73531 22415) for good after one
-- review. GaadiPe is a website from now on: checks, payments and reports on gaadipe.in; alerts by email,
-- browser notification and SMS (jobs/watch.js and jobs/expiryWatch.js already go that way while
-- whatsapp_sending_enabled is false). Nothing is deleted: chats, consents and payments stay as records.

-- 1. Nothing goes out on WhatsApp, and no template is named.
INSERT INTO app_settings (key, value) VALUES ('whatsapp_sending_enabled', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('flag_whatsapp_flow', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
UPDATE app_settings SET value = '', modified_at = now()
 WHERE key IN ('wa_template_monitoring', 'template_daily_status', 'wa_template_renewal') AND value <> '';

-- 2. The website's top bar, green: where GaadiPe is now. (The hanging notice on the site says why.)
INSERT INTO app_settings (key, value) VALUES ('site_notice_on', 'true')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('site_notice_tone', 'good')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('site_notice_en',
  'GaadiPe is now fully on the web — check vehicles, buy reports and get alerts right here on gaadipe.in.')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('site_notice_hi',
  'GaadiPe अब पूरी तरह वेब पर है — गाड़ी जाँचें, रिपोर्ट खरीदें और अलर्ट पाएँ, यहीं gaadipe.in पर।')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

-- 3. No WhatsApp number on invoices, PDFs or the site's contact details.
UPDATE business_details SET whatsapp_number = NULL WHERE whatsapp_number IS NOT NULL;
UPDATE business_details SET support_phone = NULL WHERE support_phone IN ('+917353122415', '+919739622631');

-- 4. The web admin shows every customer — those who came through WhatsApp are website customers now
--    (routes/adminApi.js). false brings back the website-only view.
INSERT INTO app_settings (key, value) VALUES ('admin_web_shows_all', 'true')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

-- 5. The policies say WhatsApp is no longer used — and that a WhatsApp message claiming to be GaadiPe is
--    not from us. Wording only; the versions stay, so nobody is asked to agree again.
UPDATE terms_and_conditions SET modified_at = now(),
  description = 'By using gaadipe.in, or any GaadiPe service or communication channel (such as SMS, email or browser notifications), you agree to be bound by these Terms & Conditions. On the website, tapping “Agree & check” before a free check, or signing in with your mobile number and the one-time code we send you, is your acceptance — the screen tells you so, and no separate box needs to be ticked. Acceptances given earlier on WhatsApp, by tapping “Agree & continue”, remain valid. We keep a record of each acceptance: the date and time, the versions of the policies in force, and where it was given from. GaadiPe is operated by ServerPe App Solutions (GSTIN 29BSMPK7696H1ZT). If you do not agree with any part of these Terms, please do not use the service.'
 WHERE title = 'Acceptance of Terms' AND is_active;

UPDATE terms_and_conditions SET modified_at = now(),
  title = 'GaadiPe on the Website, SMS and Email',
  description = 'GaadiPe is offered on our website gaadipe.in, where you check vehicles, sign in, buy reports and see your alerts, and we contact you by SMS, email and browser notifications on the devices where you allow them. GaadiPe no longer offers any service on WhatsApp (since 21 October 2026): a WhatsApp message or call claiming to be GaadiPe is not from us, and GaadiPe never asks for OTPs, card or bank details, or challan payments. If a channel is unavailable for a time, the website continues to serve you.'
 WHERE title = 'GaadiPe on the Website, SMS, Email and WhatsApp' AND is_active;

UPDATE privacy_policy SET modified_at = now(),
  title = 'Data from WhatsApp (until 21 October 2026)',
  description = 'Until 21 October 2026 GaadiPe was also offered on WhatsApp, where messages and phone numbers were processed through Meta Platforms. From that time we keep your WhatsApp number, profile name, the vehicles you checked and the chat records only as long as they are needed for your account, payments, invoices and legal records, under the same retention rules as the rest of your data. GaadiPe no longer uses WhatsApp.'
 WHERE title = 'Data on WhatsApp' AND is_active;

UPDATE privacy_policy SET modified_at = now(),
  description = 'If GaadiPe asks you to prove that you own a vehicle, you send us a photo or PDF of its registration certificate (RC) through the channel we tell you on gaadipe.in. We use it only to check that you are the owner, by comparing it with the vehicle record. It is kept encrypted, seen only by GaadiPe, never shared, and deleted as soon as we decide — whether we approve it or not. We keep only the result (verified or not) and the date. You may cover your address, photograph and date of birth before sending it.'
 WHERE title = 'Proving You Own a Vehicle' AND is_active;

UPDATE privacy_policy SET modified_at = now(),
  title = 'One Account Across the Website, SMS and Email',
  description = 'We identify you by your mobile number on gaadipe.in and on every channel we use, so your history is one account — including anything from the time GaadiPe was also on WhatsApp. To send you sign-in codes and service messages we use an SMS provider registered on the DLT system, email and browser notifications, and we share with them only your number or email and the message itself. Promotional messages are sent only if you opted in; withdrawing applies to all of these channels.'
 WHERE title = 'One Account Across Website, WhatsApp, SMS and Email' AND is_active;
