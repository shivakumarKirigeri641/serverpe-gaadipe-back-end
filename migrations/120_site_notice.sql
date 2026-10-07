-- 120_site_notice.sql (user, 2026-10-07): the WhatsApp account was disabled,
-- so gaadipe.in says so at the top of every page and sends people to the
-- website check instead. Switched and worded from admin Configuration.
--
--   site_notice_on   show it (true while WhatsApp is down)
--   site_notice_en   the English line
--   site_notice_hi   the Hindi line

INSERT INTO app_settings (key, value) VALUES
  ('site_notice_on', 'true'),
  ('site_notice_en', 'Our WhatsApp service is temporarily unavailable. You can check any vehicle, buy and download reports right here on gaadipe.in.'),
  ('site_notice_hi', 'हमारी WhatsApp सेवा अभी कुछ समय के लिए उपलब्ध नहीं है। आप यहीं gaadipe.in पर किसी भी गाड़ी की जाँच कर सकते हैं और रिपोर्ट खरीद व डाउनलोड कर सकते हैं।')
ON CONFLICT (key) DO NOTHING;
