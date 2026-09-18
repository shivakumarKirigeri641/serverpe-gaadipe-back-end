-- 032_alert_languages.sql — alerts in the customer's language, with a net.
--
-- Two templates, one per language, each approved by Meta separately:
--   gp_vehicle_alert_en_v1  (en)   1 name · 2 vehicle · 3 what · 4 details
--   gp_vehicle_alert_hi_v1  (hi)   same four parameters, in Hindi
--
-- A template waiting for approval, paused or never submitted is rejected by
-- Meta, and an alert that fails to send is an alert the customer never gets.
-- So the already-approved gp_vehicle_alert_v2 stays as the last resort — with
-- ITS parameters, which differ: 3 is what needs attention, 4 is the check date.

ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language text NOT NULL DEFAULT 'en';
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_preferred_language_check CHECK (preferred_language IN ('en', 'hi'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO app_settings (key, value) VALUES
  ('template_vehicle_alert_en',       'gp_vehicle_alert_en_v1'),
  ('template_vehicle_alert_hi',       'gp_vehicle_alert_hi_v1'),
  ('template_vehicle_alert_fallback', 'gp_vehicle_alert_v2')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

-- Replaced by the three above.
DELETE FROM app_settings WHERE key = 'template_vehicle_alert';
