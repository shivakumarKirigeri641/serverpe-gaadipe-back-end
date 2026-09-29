-- 084_support_ticket_emails.sql — who else receives support tickets and
-- contact messages (user, 2026-09-29), on top of the admin recipients.
-- Comma-separated; only these emails go there, not sign-ins, payments or the
-- daily summary. src/jobs/notify.js.

INSERT INTO app_settings (key, value) VALUES
  ('support_ticket_emails', 'shivakumar641@gmail.com')
ON CONFLICT (key) DO NOTHING;
