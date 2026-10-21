-- 198_free_view_count.sql (user, 2026-10-21: "before sign-in we show almost all — force sign-in with OTP,
-- then explore?" → "as you recommend"). The funnel stays value-first, but sign-in gives away less:
--   before sign-in   make, model, variant, fuel, masked owner, RTO (unchanged; 2 a day)
--   signed in, free  HOW MANY documents and challans need attention, not which or their dates (was
--                    'public': every validity date, age, the challan count and total)
--   ₹19 report       every date, each challan, loan, owners, FASTag, the PDF and 28 days of alerts
-- The website's words say the same (gaadipe-front-end, Chat.jsx and i18n). 'public' brings the old view
-- back. If few visitors sign in after a week, check_sign_in_required = true asks for the OTP before any check.
INSERT INTO app_settings (key, value) VALUES ('free_view_detail', 'count')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
