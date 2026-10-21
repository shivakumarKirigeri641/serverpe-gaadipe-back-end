-- 196_way2api.sql (user, 2026-10-21: "Way2API first, IDSPay as the backup"). The cheaper paid RC source
-- (vehicle/way2api.js), asked after ULIP and eChallan.app and before IDSPay. Key: WAYTWOAPI_KEY in .env.
--
--   way2api_enabled          true  — false sends every paid lookup straight to IDSPay
--   way2api_balance_usd      ''    — the Way2API wallet in dollars; ENTER IT AFTER EVERY RECHARGE.
--                                    Blank = not tracked. Below one call's price, IDSPay is asked instead
--   way2api_cost_usd         0.0254 — one call with GST ($0.0215 + 18%), taken off the balance
--   way2api_cost_paise       240   — the same in rupees (≈ $0.0254 × ₹94.3), for the money reports
--   way2api_low_balance_usd  1     — at or below it, one email a day
--   way2api_daily_limit      300   — calls per IST day; past it, IDSPay is asked
-- All editable in Settings → RC backup provider.
INSERT INTO app_settings (key, value) VALUES ('way2api_enabled', 'true') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('way2api_balance_usd', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('way2api_cost_usd', '0.0254') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('way2api_cost_paise', '240') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('way2api_low_balance_usd', '1') ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('way2api_daily_limit', '300') ON CONFLICT (key) DO NOTHING;
