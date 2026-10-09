-- 148_free_view_like_carinfo.sql (user, 2026-10-10: "carinfo.app gives free what
-- I give for ₹19" — match it, and sell the ₹19 as the buyer's report).
--
--   before sign-in   make and model WITH variant, class, fuel, the owner's name
--                    masked, and the RTO (free_check_show_variant / _owner / _rto)
--   signed in, free  the public record: every validity date, age, norms, seats,
--                    weight, RC status, how many challans (free_view_detail = public)
--   ₹19 report       loan, blacklist / NOC, every challan with amount, owners,
--                    insurer, FASTag, the buyer's verdict, PDF and 28 days of alerts
-- Buying, downloading and the alerts need sign-in (unchanged).
INSERT INTO app_settings (key, value) VALUES ('free_view_detail', 'public')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('free_check_show_variant', 'true')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('free_check_show_owner', 'true')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('free_check_show_rto', 'true')
  ON CONFLICT (key) DO NOTHING;
