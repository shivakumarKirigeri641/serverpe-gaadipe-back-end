-- 014_check_quota.sql — a lever against automation, shipped switched off.
--
-- Free checks are the product's front door: a stranger types a plate, learns
-- their PUC lapsed four months ago, and that is the moment they pay. Limiting
-- that to protect a Rs.29 subscription would be backwards, so the numbers here
-- are set where only a script can reach them.
--
-- TWO LAYERS, because a daily cap alone defends against nothing: a script burns
-- twenty checks in four seconds and has already cost the money before any
-- daily counter notices.
--
--   burst  5 checks per minute   — stops loops, scripts and runaway retries
--   daily  20 / 30 / unlimited   — stops slow, patient scraping
--
-- A person cannot send six WhatsApp messages in a minute while typing plates,
-- so the burst limit is invisible to everyone real.
--
-- ENFORCEMENT IS OFF AT LAUNCH (checks_enforce = false). Counting runs from day
-- one, so the limits can be set from what people actually do rather than from a
-- guess. If it turns out nobody exceeds six, this may never be switched on —
-- but the lever exists, and turning it on is one row, not a deploy on the worst
-- afternoon of the month.

BEGIN;

INSERT INTO app_settings (key, value) VALUES
  -- The master switch. Counting always happens; only refusal is gated.
  ('checks_enforce',                  'false'),

  ('free_checks_per_day',             '20'),   -- never subscribed
  ('free_checks_per_day_trial',       '30'),   -- during a free trial
  ('free_checks_per_day_partner',     '50'),   -- demoing is their job
  -- Paying subscribers are unlimited and are not listed: absence is the rule.

  ('checks_burst_per_minute',         '5'),
  -- Re-reading a report you just received must not cost a check. Anything
  -- longer than this on the same vehicle is a genuine re-check and counts.
  ('checks_repeat_window_minutes',    '60')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Every check is already written to event_log; this index is what makes
-- counting them cheap enough to do on the path of every single lookup.
CREATE INDEX IF NOT EXISTS idx_event_log_checks
    ON event_log (user_id, created_at DESC)
 WHERE kind = 'vehicle_check';

COMMIT;
