-- 031_alert_template.sql — the approved WhatsApp template for vehicle alerts.
--
-- Outside the 24-hour window only an approved template delivers, and nearly
-- every alert lands there: the customer bought a report days ago and has not
-- written since. The template name is a setting so a newer approved version can
-- replace it from the panel, without a deploy.
--
--   gp_vehicle_alert_v2 — parameters, in order:
--     1  customer's first name
--     2  vehicle number
--     3  what needs attention   "Insurance, PUC" / "New challan"
--     4  the details            "Insurance expires in 12 days · PUC expired 3 days ago"

INSERT INTO app_settings (key, value) VALUES
  ('template_vehicle_alert', 'gp_vehicle_alert_v2')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
