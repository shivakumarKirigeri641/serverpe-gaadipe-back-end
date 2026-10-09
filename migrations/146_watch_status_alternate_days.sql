-- 146_watch_status_alternate_days.sql (user, 2026-10-09: "turn that daily status
-- off, let's send alternate days"). After Meta's "spam rate limit hit" warning,
-- the "today's update" all-clear to paying customers goes at most every other
-- day (jobs/watch.js dailyStatus). Real alerts are not affected.
INSERT INTO app_settings (key, value) VALUES ('watch_daily_status_every_days', '2')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
