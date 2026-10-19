-- 192_web_first_new_number_coming.sql (user, 2026-10-19: "in marketing site, tell that whatsapp
-- number is disabled, till then bear the web based"). WABA 1089813687242031 (+91 97396 22631)
-- was banned after SCAM strikes on 16-18 Oct; a fresh WABA with a new number is being set up.
-- As in 169:
--   - nothing is sent on WhatsApp (send.js refuses everything while this is false)
--   - the website's top bar is on, green, saying what the visitor can do here
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
