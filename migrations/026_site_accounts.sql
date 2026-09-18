-- 026_site_accounts.sql — customers signing in to gaadipe.in.
--
-- The website is the second door into the same product. A customer who checked
-- a vehicle on WhatsApp must find that same vehicle, that same report and that
-- same invoice on the site, so there is no "website account": the mobile number
-- IS the account, and these tables only prove that the person holds it.
--
-- WHY SMS AND NOT WHATSAPP for the code: a customer may reach the site without
-- ever having messaged us, and WhatsApp will not deliver a free-form message to
-- someone outside the 24-hour window. SMS reaches anyone — see src/util/sms.js
-- for the provider slot.
--
-- Safe to run twice; adds only new tables, columns and settings.

CREATE TABLE IF NOT EXISTS site_otps (
  id          bigserial PRIMARY KEY,
  mobile      text        NOT NULL,
  code_hash   text        NOT NULL,
  attempts    integer     NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_otps_mobile ON site_otps (mobile, created_at DESC);

CREATE TABLE IF NOT EXISTS site_sessions (
  id           bigserial PRIMARY KEY,
  user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text        NOT NULL UNIQUE,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_site_sessions_live
    ON site_sessions (token_hash) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_site_sessions_user ON site_sessions (user_id, created_at DESC);

/*
 * DEACTIVATION, not deletion.
 *
 * The DPDP Act gives a person the right to withdraw consent, and this is how
 * they do it from the site: monitoring stops, alerts stop, the session ends and
 * the account cannot be signed into. What is NOT deleted is the tax record —
 * invoices are statutory and must be kept for years, whatever the customer
 * wants. Erasure of everything else is a separate, deliberate act.
 */
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_reason text;
-- A name they chose themselves, which is not the same as the WhatsApp profile
-- name Meta hands us.
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;

INSERT INTO app_settings (key, value) VALUES
  ('site_session_days',       '30'),
  ('site_otp_minutes',        '10'),
  ('site_otp_attempts',       '5'),
  ('site_otp_resend_seconds', '60'),
  -- Codes asked for from one number, per hour. A login screen on the open
  -- internet is also a way to make us send SMS at somebody else's expense.
  ('site_otp_per_hour',       '5')
ON CONFLICT (key) DO NOTHING;
