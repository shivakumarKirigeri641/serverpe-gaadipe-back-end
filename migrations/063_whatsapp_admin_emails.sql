-- 063_whatsapp_admin_emails.sql — the admin hears about what happens in the
-- WhatsApp chat (user, 2026-09-25).
--
-- GaadiPe moved onto WhatsApp and the web sign-in is hidden, so the "someone
-- arrived" email that sign-ins used to send stopped coming. These are the chat's
-- equivalents, sent by jobs/notify.js to admin_alert_emails (or ADMINMAIL).
-- Each can be switched off in the admin panel: Settings → Emails to you.
--
-- Payments (notify_payments) and feedback (notify_feedback) already email.

INSERT INTO app_settings (key, value) VALUES
  ('notify_wa_hi',           'true'),   -- someone said Hi
  ('notify_wa_checks',       'true'),   -- every vehicle checked, found or not
  ('notify_wa_opt_out',      'true'),   -- someone replied STOP
  ('notify_left_at_payment', 'true')    -- ₹19 link opened, unpaid after 30 minutes
ON CONFLICT (key) DO NOTHING;
