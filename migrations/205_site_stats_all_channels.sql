-- 205_site_stats_all_channels.sql (user, 2026-10-22: "combine agreed on both, website & WhatsApp").
-- The home page's "GaadiPe so far" counted only customers who agreed on WhatsApp (migration 180), so
-- everyone who agreed on the website was left out. Now both: anyone who agreed to the Terms on WhatsApp
-- or on the website (and has not said STOP), and the payments of both.
INSERT INTO app_settings (key, value) VALUES ('site_stats_channel', 'all')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
