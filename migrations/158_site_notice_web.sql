-- 158_site_notice_web.sql (user, 2026-10-10: remove "Our WhatsApp service is temporarily
-- unavailable. You can" from the website's top bar). The hanging notice (site
-- HangingNotice.jsx) now says why GaadiPe is on the web; the top bar keeps only what the
-- visitor can do here. Changed only while it still reads the old words, so an edit made
-- in the admin panel since is left alone. The bar turns from the yellow warning to the
-- green tone: there is nothing to warn about in "check any vehicle here".

UPDATE app_settings
   SET value = 'Check any vehicle, buy and download reports right here on gaadipe.in.', modified_at = now()
 WHERE key = 'site_notice_en'
   AND value = 'Our WhatsApp service is temporarily unavailable. You can check any vehicle, buy and download reports right here on gaadipe.in.';

UPDATE app_settings
   SET value = 'यहीं gaadipe.in पर किसी भी गाड़ी की जाँच करें और रिपोर्ट खरीदें व डाउनलोड करें।', modified_at = now()
 WHERE key = 'site_notice_hi'
   AND value = 'हमारी WhatsApp सेवा अभी कुछ समय के लिए उपलब्ध नहीं है। आप यहीं gaadipe.in पर किसी भी गाड़ी की जाँच कर सकते हैं और रिपोर्ट खरीद व डाउनलोड कर सकते हैं।';

UPDATE app_settings
   SET value = 'good', modified_at = now()
 WHERE key = 'site_notice_tone'
   AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'site_notice_en'
                AND value = 'Check any vehicle, buy and download reports right here on gaadipe.in.');
