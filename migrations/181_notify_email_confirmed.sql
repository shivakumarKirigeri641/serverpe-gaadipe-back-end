-- 181_notify_email_confirmed.sql (user, 2026-10-15: "mail me when a user confirms their mail").
-- jobs/notify.js emailConfirmations: one email to the admin each time a customer confirms an
-- email address (the 4-digit code on WhatsApp or the website, or the confirmation link).
INSERT INTO app_settings (key, value) VALUES ('notify_email_confirmed', 'true')
ON CONFLICT (key) DO NOTHING;
