-- 152_enforce_signed_in_checks.sql (user, 2026-10-10: "what if user keeps on
-- deleting, check new vehicle, delete, check new vehicle?").
--
-- Removing a vehicle never gave a check back: the daily count reads event_log
-- 'vehicle_check' rows, which a removal does not touch (util/quota.js). But the
-- limit itself was only counted, never applied — checks_enforce was still false
-- from launch (migration 014). The website's rule is 10 checks a day after
-- sign-in (migration 149), so it is switched on, and a customer on free
-- monitoring (a watch makes them 'trial') gets the same 10, not 30.
-- The same vehicle again within checks_repeat_window_minutes (60) stays free.

INSERT INTO app_settings (key, value) VALUES
  ('checks_enforce', 'true'),
  ('free_checks_per_day_trial', '10')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
