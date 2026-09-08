-- 013_trial_duration.sql — make the trial length a setting, and give a watch a
-- precise end time.
--
-- WHY A TIMESTAMP AND NOT A DATE: watches.expires_on is a date, which is the
-- right shape for a real 7-day trial but useless for testing one. Waiting a
-- week to find out whether the expiry path works is not a test anyone runs, so
-- the whole lifecycle — daily check, day-6 notice, expiry — has to be
-- compressible into a few minutes. expires_at is that clock; expires_on stays
-- as the human-facing date and is kept in step.
--
-- trial_minutes is deliberately a setting rather than a constant: production
-- runs at 10080 (7 days), a test run sets it to 1, and no code changes between
-- the two. A test that exercises different code from production tests nothing.

BEGIN;

ALTER TABLE watches ADD COLUMN IF NOT EXISTS expires_at timestamptz;

COMMENT ON COLUMN watches.expires_at IS
  'Exact end of the watch. expires_on is the same moment as a date, for display.';

-- Existing rows: end of their expiry day.
UPDATE watches SET expires_at = (expires_on + 1)::timestamptz
 WHERE expires_at IS NULL AND expires_on IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_watches_expiry ON watches (expires_at) WHERE is_active;

-- How often a watched vehicle is re-checked, and how long a trial runs. Minutes
-- throughout, so a test can set trial_minutes=1 and check_interval_minutes=1
-- and watch the entire lifecycle happen while looking at the screen.
INSERT INTO app_settings (key, value) VALUES
  ('trial_minutes',            '10080'),   -- 7 days
  ('trial_vehicles',           '1'),
  ('trial_swaps_allowed',      '1'),
  -- Day 6 of 7: far enough ahead to act, close enough to matter.
  ('trial_notice_before_minutes', '1440'),
  ('watch_check_interval_minutes', '1440')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
