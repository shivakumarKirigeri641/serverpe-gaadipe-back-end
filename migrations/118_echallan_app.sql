-- 118_echallan_app.sql (user, 2026-10-05: "1st ULIP (free), 2nd eChallan.app
-- (free), 3rd IDSPay (costing)"). eChallan.app (src/vehicle/echallanApp.js) is
-- the free second source for RC and challans. Needs ECHALLANAPP_APIKEY in .env.
--
--   echallan_app_enabled      use it (true)
--   echallan_app_timeout_ms   how long to wait before moving on (8000)
--   echallan_app_credits      the free credits left, as their last answer said
--   echallan_app_low_credits  a ping when credits fall to this (500)

INSERT INTO app_settings (key, value) VALUES
  ('echallan_app_enabled', 'true'),
  ('echallan_app_timeout_ms', '8000'),
  ('echallan_app_credits', ''),
  ('echallan_app_low_credits', '500')
ON CONFLICT (key) DO NOTHING;
