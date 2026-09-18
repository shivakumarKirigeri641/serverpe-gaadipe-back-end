-- 038_admin_mail.sql — emails to the admin, and the contact form.
--
-- admin_notifications: one row per thing the admin has been (or is being)
-- emailed about — a sign-in, a payment, a contact message, a feedback note, a
-- day's summary. UNIQUE (kind, ref) is what makes each one go exactly once,
-- whichever server tick finds it; a failure is retried a few times, then left
-- with its error for the panel to show.
--
-- contact_messages: what the "Contact us" form on gaadipe.in sends.

CREATE TABLE IF NOT EXISTS admin_notifications (
  id          bigserial   PRIMARY KEY,
  kind        text        NOT NULL,          -- sign_in | payment | contact | feedback | daily_summary
  ref         text        NOT NULL,          -- the row it is about, or the IST date for a summary
  status      text        NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  attempts    int         NOT NULL DEFAULT 0,
  last_error  text,
  sent_to     text,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_notifications_once UNIQUE (kind, ref)
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id          bigserial   PRIMARY KEY,
  name        text        NOT NULL,
  mobile      text,
  email       text,
  subject     text,
  message     text        NOT NULL,
  reg_no      text,
  user_id     bigint      REFERENCES users(id) ON DELETE SET NULL,
  language    text,
  ip          text,
  user_agent  text,
  status      text        NOT NULL DEFAULT 'new',       -- new | replied | closed
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_messages_created ON contact_messages (created_at DESC);

INSERT INTO app_settings (key, value) VALUES
  ('admin_alert_emails', ''),            -- empty: ADMINMAIL from the environment
  ('notify_sign_ins', 'true'),
  ('notify_payments', 'true'),
  ('notify_contact', 'true'),
  ('notify_feedback', 'true'),
  ('daily_summary_email', 'true'),
  ('daily_summary_hour_ist', '21'),       -- 9 pm IST, after the evening alerts
  ('contact_per_hour_per_ip', '5')
ON CONFLICT (key) DO NOTHING;
