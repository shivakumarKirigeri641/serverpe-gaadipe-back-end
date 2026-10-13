-- 167_current_offers.sql (user, 2026-10-13: "one more option in menu: current offers").
-- WhatsApp menu "Current offers" (whatsapp/flow.js currentOffers) reads prices live from
-- the plans; offers_text is the admin's own line shown on top — a festival offer, say.
-- Empty: no extra line.

INSERT INTO app_settings (key, value) VALUES ('offers_text', '')
ON CONFLICT (key) DO NOTHING;
