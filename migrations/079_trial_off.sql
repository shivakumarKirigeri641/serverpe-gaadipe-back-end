-- 079_trial_off.sql — the free monitoring trial is off (user, 2026-09-27).
-- Monitoring is strictly ₹19 per vehicle: no vehicle is watched for free.
-- 'true' brings back the "Start free trial" offer (src/whatsapp/flow.js).

INSERT INTO app_settings (key, value) VALUES
  ('trial_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
