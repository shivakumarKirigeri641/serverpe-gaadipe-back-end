-- 149_web_and_sms_platform.sql (user, 2026-10-10: "now I will go with SMS & web
-- based platform for GaadiPe"). WhatsApp is gone (Meta, 9 Oct); GaadiPe runs on
-- gaadipe.in with SMS, email and browser notifications.
--
--   free checks        3 a day before sign-in (per browser and per network), 10 signed in
--   free monitoring    14 days, one vehicle, once per mobile number (site/freeMonitor.js)
--   SMS                alerts, reminders, the one-time notice and offers on DLT templates;
--                      off until the user gives the approved template ids (sms_tpl_*)
--   sign-in            lasts while monitoring runs + 7 days (site/auth.js sessionFor)
--   Terms              15, 17, 18, 22 and 30 brought up to date

INSERT INTO app_settings (key, value) VALUES
  ('chat_anon_checks_per_day', '3'),
  ('chat_anon_checks_per_day_ip', '3'),
  ('free_checks_per_day', '10'),
  ('free_monitor_enabled', 'true'),
  ('free_monitor_days', '14'),
  ('free_monitor_notice_days', '2'),
  ('site_session_after_monitor_days', '7'),
  ('sms_alerts_enabled', 'false'),
  ('sms_tpl_expiry', ''),
  ('sms_tpl_challan', ''),
  ('sms_tpl_monitor_end', ''),
  ('sms_tpl_service', ''),
  ('sms_tpl_offers', '')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()
  WHERE app_settings.key IN ('chat_anon_checks_per_day', 'chat_anon_checks_per_day_ip', 'free_checks_per_day');

UPDATE terms_and_conditions
   SET title = 'GaadiPe on the Website, SMS and Email',
       description = 'GaadiPe is offered on our website gaadipe.in. You check vehicles, sign in, buy reports and receive your alerts there, '
         || 'and we contact you by SMS, email and browser notifications on the devices where you allow them. '
         || 'GaadiPe on WhatsApp is not available at present; any message claiming to be GaadiPe on WhatsApp is not from us.',
       version = '2.0', effective_from = CURRENT_DATE, modified_at = now()
 WHERE id = 15;

UPDATE terms_and_conditions
   SET title = 'Free Monitoring',
       description = 'After signing in you may start free monitoring for one vehicle you have checked, for 14 days. '
         || 'It is limited to one free period per mobile number — including after an account is closed and opened again — and per device. '
         || 'No payment is taken and no payment instrument is required. When the 14 days end, monitoring simply stops; '
         || 'we tell you a little before, and you may continue for Rs.19 for 28 days per vehicle, the full report included. Nothing renews or is charged automatically. '
         || 'We may change or withdraw this offer for new customers at any time; a free period already started runs to its end.',
       version = '3.0', effective_from = CURRENT_DATE, modified_at = now()
 WHERE id = 17;

UPDATE terms_and_conditions
   SET description = 'For vehicles under free or paid monitoring, GaadiPe periodically re-checks Government-sourced data and tells you of new challans '
         || 'and of insurance, emission (PUCC), fitness and road-tax expiries — by browser notification, SMS and email, as you have allowed. '
         || 'Monitoring is a best-effort convenience: source data may be delayed or incomplete, messages may be delayed or not delivered by the networks, '
         || 'and GaadiPe does not guarantee that every event is detected or notified. Always verify important matters with the RTO or the relevant authority.',
       version = '3.0', effective_from = CURRENT_DATE, modified_at = now()
 WHERE id = 18;

UPDATE terms_and_conditions
   SET title = 'Messages from GaadiPe — SMS, Email and Notifications',
       description = 'Your mobile number is your one GaadiPe account. By accepting these Terms you agree that GaadiPe may send you SERVICE messages — '
         || 'sign-in codes, receipts, your reports, and the alerts and reminders for vehicles you check or monitor — by SMS, email and browser notification, '
         || 'on the number and email you give us and the devices where you allow notifications. '
         || 'PROMOTIONAL messages — tips, new features and offers — are sent only if you opt in, by ticking the box when you sign in or in your Profile, '
         || 'and only occasionally; promotional SMS are sent only between 9 am and 9 pm. You can withdraw that at any time in your Profile or by writing to support@gaadipe.in. '
         || 'Service messages for things you have asked for continue until you close your account; closing it stops every message. '
         || 'You stay signed in on a device while any of your vehicles is monitored and for a short time after, so that our notifications open your account directly; '
         || 'you can sign out of one device or of all devices at any time. We do not sell, rent or share your mobile number or email.',
       version = '5.0', effective_from = CURRENT_DATE, modified_at = now()
 WHERE id = 22;

UPDATE terms_and_conditions
   SET description = 'Without signing in, you may check up to three vehicles a day from a browser and network address. '
         || 'Before a check you are asked to agree to these Terms, the Privacy policy and the Refund policy, and to confirm that you are checking the vehicle for a lawful purpose — '
         || 'for example because you are buying it, or it is your own. The free check shows the vehicle''s make, model and variant, class and fuel, '
         || 'the registered owner''s name masked as in the Government''s records, and the RTO it is registered at. '
         || 'After signing in you also see the validity dates of its documents and how many challans are pending; '
         || 'the loan, blacklist and NOC status, each challan in detail and the other particulars are in the full report. '
         || 'Each free check is recorded with the vehicle number, the date and time, your device, browser and network details, and what you agreed to, '
         || 'so that the service can be protected from misuse. Automated checks, repeated attempts to get round the daily limit, '
         || 'or any use listed under Prohibited Use may be blocked.',
       version = '1.1', effective_from = CURRENT_DATE, modified_at = now()
 WHERE id = 30;
