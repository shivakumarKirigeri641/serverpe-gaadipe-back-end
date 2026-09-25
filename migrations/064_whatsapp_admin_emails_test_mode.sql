-- 064_whatsapp_admin_emails_test_mode.sql — test the WhatsApp admin emails on
-- one number first (user, 2026-09-25).
--
-- While this lists numbers, jobs/notify.js emails about Hi, checks, STOP and
-- unpaid links only for activity from those numbers. Clear it in the admin
-- panel (Settings → Emails to you) to be told about every customer.
-- Starts with the owner's number, so the first emails are the owner's tests.

INSERT INTO app_settings (key, value) VALUES
  ('notify_wa_only_from', '9886122415')
ON CONFLICT (key) DO NOTHING;
