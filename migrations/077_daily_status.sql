-- 077_daily_status.sql — a daily "all clear" for paying customers (user,
-- 2026-09-27). While GaadiPe is new, every paying customer with monitoring
-- on hears each evening even when nothing changed. Switch off here when only
-- real changes should be sent. src/jobs/watch.js dailyStatus().

INSERT INTO app_settings (key, value) VALUES
  ('watch_daily_status_enabled', 'true'),
  -- Outside the 24-hour window an approved template is needed: the approved
  -- monitoring alert — 1 first name, 2 vehicle, 3 status details, 4 action.
  ('template_daily_status',      'gp_monitoring_alert_en_v1')
ON CONFLICT (key) DO NOTHING;
