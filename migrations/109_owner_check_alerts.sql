-- 109_owner_check_alerts.sql — "someone checked your vehicle" (user, 2026-10-04,
-- src/owners/checkAlerts.js). When another person checks a vehicle whose
-- verified owner holds a GaadiPe report, the owner is told: which vehicle,
-- when, and the last four digits of the number that checked it.
--
-- One row per check that reached (or will reach) an owner. The checker's
-- number is kept only as its last four digits and a one-way hash (so the
-- same person checking twice in a day is one alert, not two).
--
--   status  pending   their WhatsApp window was shut and no template is on:
--                     told, as a summary, the next time they write
--           sent      told on WhatsApp inside the window
--           template  told by the approved template
--           summarised  included in a "while you were away" summary

CREATE TABLE IF NOT EXISTS owner_check_alerts (
  id             bigserial   PRIMARY KEY,
  owner_mobile   text        NOT NULL,
  reg_no         text        NOT NULL,
  checker_last4  text        NOT NULL,
  checker_hash   text        NOT NULL,
  channel        text        NOT NULL DEFAULT 'whatsapp',
  status         text        NOT NULL DEFAULT 'pending',
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_check_alerts_owner ON owner_check_alerts (owner_mobile, created_at DESC);
CREATE INDEX IF NOT EXISTS owner_check_alerts_pending ON owner_check_alerts (owner_mobile) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS owner_check_alerts_dedupe ON owner_check_alerts (reg_no, checker_hash, created_at DESC);

INSERT INTO app_settings (key, value) VALUES
  ('owner_check_alert_on', 'false'),
  -- Only owners who hold a GaadiPe report for the vehicle that is still running
  ('owner_check_alert_need_report', 'true'),
  -- At most this many alerts an owner gets in a day (the rest wait for the summary)
  ('owner_check_alert_per_day', '10'),
  -- Tell the person checking that the verified owner is informed
  ('owner_check_alert_tell_checker', 'true'),
  ('owner_check_alert_template_on', 'false'),
  ('owner_check_alert_template_name', 'gp_vehicle_check_alert_v1'),
  ('owner_check_alert_template_language', 'en')
ON CONFLICT (key) DO NOTHING;
