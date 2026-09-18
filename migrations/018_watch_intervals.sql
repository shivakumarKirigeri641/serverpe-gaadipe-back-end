-- 018_watch_intervals.sql — how often a watched vehicle is actually re-checked.
--
-- One interval for everything was a testing convenience of mine and it is
-- expensive: daily checks of all three datasets cost 112 upstream calls per
-- vehicle per 28-day cycle. ULIP is free today, so that is invisible — and it
-- is exactly the kind of invisible commitment that becomes a crisis the day a
-- provider publishes a price list.
--
-- Per-dataset intervals cost 20 calls for the same cycle, an 82% reduction, and
-- the customer barely notices:
--
--   CHALLAN  48h   the only thing that genuinely changes week to week, and a
--                  challan surfacing a day later is still weeks before the
--                  postal notice arrives
--   RC        7d   insurance, PUC, fitness and tax are dates, not events. They
--                  do not move between checks; only the countdown does, and we
--                  compute that ourselves without asking anyone
--   FASTAG   30d   tag status changes almost never
--
-- Break-even against a hypothetical ULIP price goes from Rs.0.25 per call to
-- Rs.1.65 — the difference between a business that dies on the announcement and
-- one that adjusts a setting.
--
-- These are settings, not constants, because the right answer will change: if
-- ULIP charges, widen them from the database; if challan data starts arriving
-- faster, narrow the first one. Neither should need a deploy.

BEGIN;

INSERT INTO app_settings (key, value) VALUES
  ('watch_interval_minutes_challan', '2880'),    -- 48 hours
  ('watch_interval_minutes_rc',     '10080'),    -- 7 days
  ('watch_interval_minutes_fastag', '43200')     -- 30 days
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- The single-interval setting stays as the fallback and as the test dial: set
-- it to 1 and every dataset is checked every minute, which is how the whole
-- lifecycle is exercised in two minutes instead of a week.
UPDATE app_settings SET value = '2880' WHERE key = 'watch_check_interval_minutes';

-- Existing watches keep their own columns; bring them in line with the above so
-- nothing carries the testing values into production.
UPDATE watches SET
  challan_interval_hours = 48,
  rc_interval_hours      = 168,
  fastag_interval_hours  = 720
WHERE is_active;

COMMIT;
