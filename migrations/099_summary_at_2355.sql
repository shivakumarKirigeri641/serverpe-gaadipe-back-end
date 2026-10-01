-- 099_summary_at_2355.sql — the daily summaries (email and the admin's own
-- WhatsApp) go at 11:55 pm IST, so they cover the whole day (user, 2026-10-01).
-- Only changed where still at the old default of 9 pm; a time set by hand stays.

UPDATE app_settings SET value = '23:55', modified_at = now()
 WHERE key IN ('daily_summary_hour_ist', 'admin_whatsapp_summary_hour_ist') AND value IN ('21', '');

INSERT INTO app_settings (key, value) VALUES
  ('daily_summary_hour_ist', '23:55'),
  ('admin_whatsapp_summary_hour_ist', '23:55')
ON CONFLICT (key) DO NOTHING;
