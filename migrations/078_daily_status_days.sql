-- 078_daily_status_days.sql — the daily all-clear only in the first week
-- (user, 2026-09-27). After that a customer hears only when something
-- changes. 0 = every day for as long as monitoring runs.

INSERT INTO app_settings (key, value) VALUES
  ('watch_daily_status_days', '7')
ON CONFLICT (key) DO NOTHING;
