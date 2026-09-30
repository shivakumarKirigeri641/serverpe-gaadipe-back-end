-- 088_whatsapp_free_count.sql — WhatsApp's free check stops naming what needs
-- attention (user, 2026-09-30). "Insurance — expired" answered the question
-- the ₹19 report is for, and people stopped at the free check. 'count' says
-- how many things need attention, never which.

UPDATE app_settings SET value = 'count' WHERE key = 'whatsapp_free_view_detail';
