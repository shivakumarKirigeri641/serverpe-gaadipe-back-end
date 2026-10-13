-- 166_sms_service_broadcast.sql (user, 2026-10-13: "broadcast all 158 that we are on WhatsApp
-- now — at least that I have to send to all"; admin/smsBroadcast.js mode 'service').
--
--   sms_tpl_service        (exists since migration 149) the Fast2SMS DLT message id of an
--                          approved SERVICE IMPLICIT template — a factual update, no offer
--   sms_tpl_service_text   its wording as approved, with any {#var#} — shown in the panel
-- A service notice may go to every customer who agreed (no offers opt-in needed), from the
-- usual sender header; the promotional template stays for opted-in customers only.

INSERT INTO app_settings (key, value) VALUES
  ('sms_tpl_service', ''),
  ('sms_tpl_service_text', '')
ON CONFLICT (key) DO NOTHING;
