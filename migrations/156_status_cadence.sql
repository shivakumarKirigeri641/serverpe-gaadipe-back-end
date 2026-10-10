-- 156_status_cadence.sql (user, 2026-10-10: "automated alerts by browser, email and
-- SMS once DLT is approved; first 7 days every day, then alternate days, then only
-- when changes — engaged, not spam; configurable in the admin panel").
--
-- jobs/watch.js dailyStatus, per vehicle from the day its monitoring started (paid
-- or free): every day for watch_status_daily_days, then every other day until day
-- watch_status_alternate_until_day, then only real alerts. Email, notification, and
-- SMS on sms_tpl_status once approved. The old watch_daily_status_every_days and
-- watch_daily_status_days are no longer read.

INSERT INTO app_settings (key, value) VALUES
  ('watch_daily_status_enabled', 'true'),
  ('watch_status_daily_days', '7'),
  ('watch_status_alternate_until_day', '28'),
  ('sms_tpl_status', '')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()
  WHERE app_settings.key IN ('watch_daily_status_enabled');
