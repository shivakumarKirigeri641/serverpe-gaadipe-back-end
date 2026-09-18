-- 033_alert_v2_only.sql — daily alerts use gp_vehicle_alert_v2 until the new
-- per-language templates are approved by Meta.
--
-- gp_vehicle_alert_en_v1 / gp_vehicle_alert_hi_v1 stay configured; setting this
-- to 'true' (Settings in the admin panel) switches alerts over to them, with v2
-- still the net underneath.

INSERT INTO app_settings (key, value) VALUES
  ('template_vehicle_alert_languages_live', 'false')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
