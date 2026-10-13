-- 165_sms_promo_broadcast.sql (user, 2026-10-13: "broadcast SMS from the admin panel — select
-- the people and send them the 3-variable DLT promotional template"). admin/smsBroadcast.js.
--
--   sms_tpl_promo        the Fast2SMS DLT message id of the approved promotional template
--   sms_tpl_promo_text   its wording as approved, with {#var#} three times — shown in the
--                        panel so the admin sees what each customer will read
--   sms_promo_per_day    at most this many promotional SMS queued per day (all admins)
-- Promotional SMS go only to customers who opted in to offers and newsletters, between
-- 10 am and 9 pm IST (util/sms.js).

INSERT INTO app_settings (key, value) VALUES
  ('sms_tpl_promo', ''),
  ('sms_tpl_promo_text', ''),
  ('sms_promo_per_day', '500'),
  -- The promotional header (6 digits) the template is registered under — not the transactional sender.
  ('sms_promo_sender_id', '')
ON CONFLICT (key) DO NOTHING;
