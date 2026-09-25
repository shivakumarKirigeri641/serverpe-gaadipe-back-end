-- 068_admin_alerts.sql — the command center's alert center (user, 2026-09-25,
-- phase 6).
--
-- An alert is raised by the checker (src/jobs/alerts.js) when a rule trips —
-- the records API failing, WhatsApp deliveries failing, payments failing, a
-- job gone quiet, a traffic spike, the day's revenue target met — and
-- resolved by it when the rule clears. The admin can acknowledge ("I've seen
-- it") and resolve by hand. `rule_key` keeps one open alert per condition:
-- while it stays tripped, the same row is seen again (last_seen_at, seen_count)
-- rather than a new alert every minute.
--
-- Not the `alerts` table: that one holds the vehicle alerts sent to customers.

CREATE TABLE IF NOT EXISTS admin_alerts (
  id               bigserial   PRIMARY KEY,
  rule_key         text        NOT NULL,
  severity         text        NOT NULL,                 -- critical | warning | info | success
  source           text        NOT NULL,                 -- records_api, whatsapp, payments, jobs, traffic, revenue, email
  title            text        NOT NULL,
  description      text,
  detail           jsonb       NOT NULL DEFAULT '{}',
  status           text        NOT NULL DEFAULT 'open',  -- open | acknowledged | resolved
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  seen_count       integer     NOT NULL DEFAULT 1,
  acknowledged_at  timestamptz,
  acknowledged_by  bigint,
  resolved_at      timestamptz,
  resolved_by      bigint,                               -- NULL with resolved_at: resolved by the checker
  resolution       text
);
-- At most one unresolved alert per condition.
CREATE UNIQUE INDEX IF NOT EXISTS admin_alerts_open_rule ON admin_alerts (rule_key) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS admin_alerts_time_idx ON admin_alerts (created_at);

-- The thresholds, editable in Settings → Alerts.
INSERT INTO app_settings (key, value) VALUES
  ('alerts_enabled',                    'true'),
  ('alert_api_error_pct',               '20'),     -- records API: failures in the last 15 minutes
  ('alert_api_p95_ms',                  '8000'),   -- records API: slowest 5% over this, last 30 minutes
  ('alert_wa_failure_pct',              '10'),     -- WhatsApp: failed sends in the last hour (at least 5 sent)
  ('alert_payment_failures_hour',       '3'),      -- payments with a failed attempt in the last hour
  ('alert_traffic_spike_pct',           '40'),     -- website visitors this hour vs the 7-day hourly average
  ('alert_daily_revenue_target_paise',  '0'),      -- 0 = no revenue-target alert
  ('notify_alerts',                     'true')    -- email critical and warning alerts to the admin
ON CONFLICT (key) DO NOTHING;
