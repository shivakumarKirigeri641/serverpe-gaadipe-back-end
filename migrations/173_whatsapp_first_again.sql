-- 173_whatsapp_first_again.sql (user, 2026-10-14 night: "Meta has restored the account again,
-- revert to WhatsApp based"). Meta GET that night: WABA 1089813687242031 review APPROVED,
-- +91 97396 22631 CONNECTED, quality GREEN. Undoes 169: WhatsApp sending on, the website's
-- top bar off (the site is rebuilt WhatsApp-first, VITE_WHATSAPP_ENABLED=1). Terms 15
-- (v5.3) already reads right either way.
INSERT INTO app_settings (key, value) VALUES ('whatsapp_sending_enabled', 'true')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

INSERT INTO app_settings (key, value) VALUES ('site_notice_on', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
