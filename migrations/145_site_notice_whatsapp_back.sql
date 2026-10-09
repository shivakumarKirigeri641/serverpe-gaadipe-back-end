-- 145_site_notice_whatsapp_back.sql (user, 2026-10-09: "in gaadipe.in, show that
-- WhatsApp is back"). The notice bar from migration 120 turns green with an
-- "Open WhatsApp" button (site_notice_tone = good). Turn it off later from admin
-- Configuration (site_notice_on = false) once people know.
INSERT INTO app_settings (key, value) VALUES ('site_notice_tone', 'good')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

UPDATE app_settings SET value = 'true', modified_at = now() WHERE key = 'site_notice_on';
UPDATE app_settings SET value = 'GaadiPe is back on WhatsApp! Check any vehicle and get your reports right in WhatsApp — the website works too.', modified_at = now()
 WHERE key = 'site_notice_en';
UPDATE app_settings SET value = 'GaadiPe फिर से WhatsApp पर है! किसी भी गाड़ी की जाँच करें और रिपोर्ट सीधे WhatsApp पर पाएँ — वेबसाइट भी चालू है।', modified_at = now()
 WHERE key = 'site_notice_hi';
