-- 178_renewal_template_off.sql (user, 2026-10-15: "renewal reminders reach customers by WhatsApp
-- only within 24 hours — did you handle this?"). gp_renewal_en_v1 does not exist on the new
-- WhatsApp account yet, so the reminder job (jobs/renewal.js) must not try it: with this empty,
-- a customer outside their 24-hour window gets the reminder by email and phone notification
-- only, and nothing is refused by Meta. Inside the window the free message still goes.
-- Once the template is approved, set wa_template_renewal = gp_renewal_en_v1 in Settings.
INSERT INTO app_settings (key, value) VALUES ('wa_template_renewal', '')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
