-- 147_whatsapp_disabled_again.sql (user, 2026-10-09): Meta disabled the WhatsApp
-- account again the evening it was restored (WABA 1529987455442947 "Disabled ·
-- breach of Terms of Acceptable Use", both numbers BANNED). A review is requested.
--   - nothing is sent on WhatsApp (send.js refuses everything while this is false)
--   - the website's top bar goes back to the yellow warning, English and Hindi
-- The website itself is rebuilt website-first (VITE_WHATSAPP_ENABLED=0, VITE_WEB_LOGIN=1).
INSERT INTO app_settings (key, value) VALUES ('whatsapp_sending_enabled', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

INSERT INTO app_settings (key, value) VALUES ('site_notice_on', 'true')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('site_notice_tone', 'warn')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('site_notice_en',
  'Our WhatsApp service is temporarily unavailable. You can check any vehicle, buy and download reports right here on gaadipe.in.')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('site_notice_hi',
  'हमारी WhatsApp सेवा अभी कुछ समय के लिए उपलब्ध नहीं है। आप यहीं gaadipe.in पर किसी भी गाड़ी की जाँच कर सकते हैं और रिपोर्ट खरीद व डाउनलोड कर सकते हैं।')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
