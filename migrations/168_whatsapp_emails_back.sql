-- 168_whatsapp_emails_back.sql (user, 2026-10-14: "i want mails when user says Hi, Agree &
-- agreeing for offers, vehicle numbers, payment, feedback, contact etc, later i will switch
-- them off"; "yes i want whatsapp emails back"). jobs/notify.js runs the WhatsApp emails
-- again (stopped 7 Oct). Every switch on; notify_wa_agreed is new (Agree / offers).
-- notify_wa_only_from emptied, so activity from every number is emailed, not only test ones.

INSERT INTO app_settings (key, value) VALUES
  ('notify_wa_hi', 'true'), ('notify_wa_agreed', 'true'), ('notify_wa_checks', 'true'),
  ('notify_wa_opt_out', 'true'), ('notify_left_at_payment', 'true'),
  ('notify_payments', 'true'), ('notify_feedback', 'true'), ('notify_contact', 'true')
ON CONFLICT (key) DO UPDATE SET value = 'true', modified_at = now();

UPDATE app_settings SET value = '', modified_at = now() WHERE key = 'notify_wa_only_from';
