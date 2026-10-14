-- 169_web_first_again.sql (user, 2026-10-14: "again disabled — revert back-end & front-end to
-- web based now"). The new WhatsApp account (WABA 1089813687242031, +91 97396 22631) was
-- disabled the day after it was restored: review REJECTED, number BANNED, display name
-- DECLINED. As on 9 Oct (147, 158):
--   - nothing is sent on WhatsApp (send.js refuses everything while this is false)
--   - the website's top bar is on again, green, saying what the visitor can do here
-- The website is rebuilt web-first (VITE_WHATSAPP_ENABLED=0, VITE_WEB_LOGIN=1).
INSERT INTO app_settings (key, value) VALUES ('whatsapp_sending_enabled', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

INSERT INTO app_settings (key, value) VALUES ('site_notice_on', 'true')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('site_notice_tone', 'good')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('site_notice_en',
  'Check any vehicle, buy and download reports right here on gaadipe.in.')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('site_notice_hi',
  'यहीं gaadipe.in पर किसी भी गाड़ी की जाँच करें और रिपोर्ट खरीदें व डाउनलोड करें।')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
