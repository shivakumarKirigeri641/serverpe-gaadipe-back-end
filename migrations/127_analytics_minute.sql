-- 127_analytics_minute.sql — MINUTE-BY-MINUTE FIGURES (user, 2026-10-07; the
-- web admin's Live analytics, spec §22–23, §44, §53).
--
-- One row per minute (Indian time is only a display matter: buckets are UTC
-- minutes), written by jobs/analyticsRollup.js every minute for the last few
-- minutes (late events are caught), so a chart never scans the raw tables. The
-- current, unfinished minute is computed live on top. Hours and days are sums
-- of these rows. Kept analytics_minute_retention_days (default 35).
--
-- active_sessions counts website visits alive at any moment of the minute — a
-- presence figure, never a running total.

CREATE TABLE IF NOT EXISTS analytics_minute (
  bucket           timestamptz PRIMARY KEY,
  visitors         integer NOT NULL DEFAULT 0,   -- distinct browsers with any website event
  active_sessions  integer NOT NULL DEFAULT 0,   -- visits alive during the minute
  page_views       integer NOT NULL DEFAULT 0,
  interactions     integer NOT NULL DEFAULT 0,
  searches         integer NOT NULL DEFAULT 0,   -- vehicle numbers searched on the site
  free_checks      integer NOT NULL DEFAULT 0,
  web_checks       integer NOT NULL DEFAULT 0,
  otp_requests     integer NOT NULL DEFAULT 0,
  otp_success      integer NOT NULL DEFAULT 0,
  otp_failed       integer NOT NULL DEFAULT 0,
  pay_attempts     integer NOT NULL DEFAULT 0,
  payments         integer NOT NULL DEFAULT 0,
  revenue_paise    bigint  NOT NULL DEFAULT 0,
  reports          integer NOT NULL DEFAULT 0,
  api_calls        integer NOT NULL DEFAULT 0,
  api_failures     integer NOT NULL DEFAULT 0,
  api_ms_sum       bigint  NOT NULL DEFAULT 0,   -- for the average latency
  errors           integer NOT NULL DEFAULT 0,   -- site errors + failed sign-ins + API failures
  computed_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value) VALUES
  ('analytics_minute_retention_days', '35')
ON CONFLICT (key) DO NOTHING;
