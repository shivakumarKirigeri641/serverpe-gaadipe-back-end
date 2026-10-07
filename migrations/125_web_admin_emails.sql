-- 125_web_admin_emails.sql (user, 2026-10-07: "mail trigger to admin, for me").
-- The website's moments are emailed to the admin as WhatsApp's were
-- (src/jobs/notify.js), each with its own switch, set from the website admin
-- (webadmin.gaadipe.in → Emails). All on to begin with.

INSERT INTO app_settings (key, value) VALUES
  ('notify_web_checks',  'true'),   -- a vehicle checked on the website after signing in
  ('notify_chat_checks', 'true'),   -- a free check in the chat, without signing in
  ('notify_push_on',     'true')    -- a customer allowed notifications on a phone
ON CONFLICT (key) DO NOTHING;
