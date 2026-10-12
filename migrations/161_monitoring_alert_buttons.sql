-- 161_monitoring_alert_buttons.sql (user, 2026-10-12): the new monitoring template
-- gp_monitoringalert_en_v1 (migration 160) carries three quick-reply buttons —
-- "Thanks for remembering", "Check vehicle", "Pause this alert" — handled in
-- src/whatsapp/monitorAlert.js.
--
-- alert_snoozes: "Pause this alert" holds that vehicle's alert back until `until`
-- (alert_pause_days, 30); "Resume alerts" ends it early. document is a DOCUMENTS
-- key from jobs/expiryWatch.js, or 'all' (every alert on the vehicle).

CREATE TABLE IF NOT EXISTS alert_snoozes (
  id          bigserial   PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id  bigint      NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  document    text        NOT NULL,
  reason      text        NOT NULL DEFAULT 'paused',
  until       timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_snoozes_lookup ON alert_snoozes (user_id, vehicle_id, until);

-- Every monitoring send uses the new template (the old gp_monitoring_alert_en_v1 is gone, 159).
UPDATE app_settings SET value = 'gp_monitoringalert_en_v1', modified_at = now()
 WHERE key IN ('template_daily_status', 'wa_template_monitoring');

INSERT INTO app_settings (key, value) VALUES ('alert_pause_days', '30')
ON CONFLICT (key) DO NOTHING;
