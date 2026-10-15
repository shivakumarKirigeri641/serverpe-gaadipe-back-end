-- 180_site_stats_whatsapp.sql (user, 2026-10-15: "GaadiPe so far — currently serving WhatsApp,
-- give WhatsApp only"). The home page's public totals (site/stats.js) count only customers who
-- agreed on WhatsApp and their WhatsApp payments. 'web' for the website's, 'all' for both —
-- switch it with the site's mode.
INSERT INTO app_settings (key, value) VALUES ('site_stats_channel', 'whatsapp')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
