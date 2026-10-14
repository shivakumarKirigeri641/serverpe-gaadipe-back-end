-- 175_whatsapp_free_public.sql (user, 2026-10-14: "CarInfo shows almost everything after
-- sign-in — show the same on WhatsApp, it is already signed in"). The free check on WhatsApp
-- now shows the website's signed-in level (whatsapp/report.js publicText): owner masked,
-- registration date and age, RC status, norms, seats, weight, RTO and its state website,
-- every validity date, pending challans with their total. 'count' goes back to the old
-- "N things need attention".
INSERT INTO app_settings (key, value) VALUES ('whatsapp_free_view_detail', 'public')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
