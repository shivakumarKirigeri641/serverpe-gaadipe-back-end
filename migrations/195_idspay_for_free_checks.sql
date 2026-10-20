-- 195_idspay_for_free_checks.sql (user, 2026-10-20: "even free checks shall we call IDSPay … on the
-- full report and the next time the user checks any vehicle or My reports, call IDSPay to get updated
-- details … I treat this as an investment until I get a cheaper API provider").
--
-- ULIP's VAHAN answers for yellow-plate (commercial / transport) vehicles only — ULIP said so by mail —
-- so a private vehicle's RC comes only from the paid source (IDSPay, ~₹2.95 a call).
--
--   rc_backup_paid_only        false — free checks (WhatsApp, signed-in website) may use IDSPay when ULIP
--                              has no RC. NOTE: the low-balance guard (115) sets it back to true and tells
--                              the admin when rc_backup_balance_paise falls to rc_backup_low_balance_paise.
--   free_check_backup_per_day  100 (was 30) — the website's checks before sign-in, IDSPay per IST day
--   rc_backup_daily_limit      300 (was 200) — every IDSPay call per IST day, the overall safety cap
--                              (~₹885); past it, ULIP's answer stands, as before
--   rc_owner_refresh_hours     24 — a paying customer's own vehicle, checked again or its report opened,
--                              is looked up fresh at most once a day (vehicle/rcConfirm.ownerRefresh)
--   rc_confirm_days            3  — before an expiry alert or a monitoring update repeats a saved date,
--                              at most once per vehicle per 3 days (vehicle/rcConfirm.refresh)
-- All of them editable in Settings.
INSERT INTO app_settings (key, value) VALUES ('rc_backup_paid_only', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('free_check_backup_per_day', '100')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('rc_backup_daily_limit', '300')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('rc_owner_refresh_hours', '24')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('rc_confirm_days', '3')
  ON CONFLICT (key) DO NOTHING;
