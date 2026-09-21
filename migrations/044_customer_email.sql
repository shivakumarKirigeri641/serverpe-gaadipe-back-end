-- 044_customer_email.sql — vehicle updates to customers by email (user, 2026-09-21).
--
-- Until GaadiPe has a WhatsApp Business number, email carries the monitoring:
--   * a paying customer (an active subscription) gets a DAILY email with the
--     full record of each vehicle they paid for, and what changed;
--   * a signed-in customer who has not paid gets the BASIC view of the vehicles
--     they checked, once every few days (customer_email_free_every_days).
--
-- An address is used only once its owner has confirmed it (one click), and every
-- email carries a one-click unsubscribe. While customer_email_only_to is set,
-- customer email goes ONLY to those addresses; everything else is recorded as
-- skipped — the switch the owner turns off when ready to go live.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at     timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_unsubscribed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_token           text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_token ON users (email_token) WHERE email_token IS NOT NULL;

-- Findings the email has already reported (WhatsApp keeps its own sent_at).
ALTER TABLE pending_alerts ADD COLUMN IF NOT EXISTS emailed_at timestamptz;

CREATE TABLE IF NOT EXISTS customer_emails (
  id          bigserial PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text        NOT NULL,              -- confirm | daily | digest
  to_email    text,
  ist_date    date,
  status      text        NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  subject     text,
  vehicles    jsonb,
  error       text,
  attempts    integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
-- At most one daily and one digest per customer per day, whatever retries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_emails_day
    ON customer_emails (user_id, kind, ist_date) WHERE kind IN ('daily', 'digest');
CREATE INDEX IF NOT EXISTS idx_customer_emails_recent ON customer_emails (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_emails_pending ON customer_emails (id) WHERE status = 'pending';

INSERT INTO app_settings (key, value) VALUES
  ('customer_email_enabled',          'true'),
  -- TEST MODE: only these addresses receive customer email. Clear it to go live.
  ('customer_email_only_to',          'shivakumar641@gmail.com'),
  ('customer_email_hour_ist',         '19'),
  ('customer_email_until_hour_ist',   '22'),
  ('customer_email_free_every_days',  '4'),
  ('customer_email_free_active_days', '90'),
  ('customer_email_per_tick',         '10')
ON CONFLICT (key) DO NOTHING;
