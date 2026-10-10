-- 155_sms_and_push_log.sql (user, 2026-10-10: "SMS template for manual sends to
-- specific users in the admin panel; SMS status for every user — yet to send,
-- sent, next to send; the web notifications the same").
--
--   notify_log     every SMS and every browser notification, as it happened:
--                  sent / failed / skipped (and why) / simulated / no_device.
--                  Sign-in codes are logged as 'otp' with no content.
--   notify_queue   what is waiting to go — a manual send from the web admin,
--                  now or at a time; jobs/reach.js sends it.
--   sms_tpl_manual the placeholder DLT template for manual SMS: its Fast2SMS
--                  message id, the approved wording and how many variables —
--                  all empty until the user has it approved.

CREATE TABLE IF NOT EXISTS notify_log (
  id           bigserial   PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  channel      text        NOT NULL,              -- sms | push
  kind         text        NOT NULL,              -- otp, expiry, challan, monitor_end, service, offers, manual, renewal, ticket …
  user_id      bigint      REFERENCES users(id) ON DELETE SET NULL,
  mobile       text,
  status       text        NOT NULL,              -- sent | failed | skipped | simulated | no_device
  error        text,
  provider_id  text,
  preview      text,                              -- the values / title and body; never a code
  devices      integer,                           -- push: delivered to this many devices
  queue_id     bigint,
  admin_id     bigint
);
CREATE INDEX IF NOT EXISTS notify_log_user_idx    ON notify_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notify_log_mobile_idx  ON notify_log (mobile, created_at DESC);
CREATE INDEX IF NOT EXISTS notify_log_channel_idx ON notify_log (channel, created_at DESC);

CREATE TABLE IF NOT EXISTS notify_queue (
  id          bigserial   PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  channel     text        NOT NULL,               -- sms | push
  kind        text        NOT NULL,               -- sms: manual | service | offers; push: manual
  user_id     bigint      REFERENCES users(id) ON DELETE CASCADE,
  mobile      text,
  vals        jsonb       NOT NULL DEFAULT '[]',  -- SMS template variables, in order
  title       text,
  body        text,
  url         text,
  send_at     timestamptz NOT NULL DEFAULT now(),
  status      text        NOT NULL DEFAULT 'queued',   -- queued | sent | failed | skipped | cancelled
  result      text,
  sent_at     timestamptz,
  admin_id    bigint,
  note        text
);
CREATE INDEX IF NOT EXISTS notify_queue_due_idx  ON notify_queue (status, send_at);
CREATE INDEX IF NOT EXISTS notify_queue_user_idx ON notify_queue (user_id, status);

INSERT INTO app_settings (key, value) VALUES
  ('sms_tpl_manual', ''),
  ('sms_tpl_manual_text', ''),
  ('sms_tpl_manual_vars', '1'),
  ('reach_sms_per_tick', '20'),
  ('reach_push_per_tick', '50'),
  -- Emails to the admin (jobs/notify.js), each switchable on the web admin's Emails page.
  ('notify_free_monitor', 'true'),
  ('notify_checks_month', 'true'),
  ('notify_reach_done', 'true')
ON CONFLICT (key) DO NOTHING;
