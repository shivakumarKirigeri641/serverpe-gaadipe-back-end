-- Where a customer arrived from (2026-10-07). Every new customer was recorded as
-- 'whatsapp' — website sign-ups too — because the shared upsert never said
-- otherwise. New customers now come only from the website (default 'web'), and
-- those already recorded are corrected: a customer who signed in on the website
-- before ever writing on WhatsApp (or never wrote) arrived from the website.
ALTER TABLE users ALTER COLUMN signup_channel SET DEFAULT 'web';

UPDATE users u SET signup_channel = 'web'
 WHERE u.signup_channel = 'whatsapp'
   AND EXISTS (SELECT 1 FROM site_sessions ss WHERE ss.user_id = u.id)
   AND NOT EXISTS (
         SELECT 1 FROM whatsapp_sessions ws
          WHERE ws.mobile = u.mobile
            AND ws.created_at < (SELECT min(ss.created_at) FROM site_sessions ss WHERE ss.user_id = u.id));
