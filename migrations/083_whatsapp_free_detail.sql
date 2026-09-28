-- 083_whatsapp_free_detail.sql — how much WhatsApp's free check names
-- (user, 2026-09-28). 'labels': "PUC — expired", "Challans — 2 pending",
-- never dates, amounts or details. 'count': only "2 things need attention".
-- Separate from the website's free_view_detail, which stays as it is: the
-- website's visitors are mostly buyers, WhatsApp's mostly owners.

INSERT INTO app_settings (key, value) VALUES
  ('whatsapp_free_view_detail', 'labels')
ON CONFLICT (key) DO NOTHING;
