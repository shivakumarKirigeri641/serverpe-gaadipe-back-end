-- 025_admin.sql — what the admin panel needs: named people, their sessions, a
-- record of what they did, and the block list.
--
-- WHY NAMED PEOPLE AND NOT ONE SHARED PASSWORD: this panel reads every
-- customer's mobile number, their vehicles and their payments, and it can
-- change prices and policy text. "Who saw this, and who changed that" has to be
-- answerable, which needs a row per person and a row per action.
--
-- SIGN-IN IS BY CODE, not a password. Every admin is a mobile number we already
-- know, there is no password to leak, reuse or reset, and the same mechanism
-- serves the customer site later. During development the code is fixed (see
-- ADMIN_DEV_OTP in src/config.js) — which is exactly why the code refuses to
-- use a fixed code when NODE_ENV=production.
--
-- Safe to run twice; adds only new tables, settings and indexes.

CREATE TABLE IF NOT EXISTS admin_users (
  id            bigserial PRIMARY KEY,
  mobile        text        NOT NULL UNIQUE CHECK (mobile ~ '^[0-9]{10}$'),
  name          text        NOT NULL,
  -- owner   everything, including adding other admins
  -- admin   everything except managing admins
  -- finance money, invoices and reports only
  -- viewer  read-only
  role          text        NOT NULL DEFAULT 'admin'
                CHECK (role IN ('owner', 'admin', 'finance', 'viewer')),
  is_active     boolean     NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  modified_at   timestamptz NOT NULL DEFAULT now()
);

-- A desk session on a laptop that gets left open, so it is short and it ends
-- on idleness as well as on sign-out.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id           bigserial PRIMARY KEY,
  admin_id     bigint      NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  -- The token is stored hashed: a leaked database backup must not hand anyone
  -- a working session.
  token_hash   text        NOT NULL UNIQUE,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_live
    ON admin_sessions (token_hash) WHERE ended_at IS NULL;

-- Every action that changes something, and every look at a customer's details.
CREATE TABLE IF NOT EXISTS admin_audit (
  id         bigserial PRIMARY KEY,
  admin_id   bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  action     text        NOT NULL,
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON admin_audit (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit (action, created_at DESC);

-- Codes are stored hashed and short-lived, and attempts are counted on the row
-- so moving to another browser does not reset them.
CREATE TABLE IF NOT EXISTS admin_otps (
  id          bigserial PRIMARY KEY,
  mobile      text        NOT NULL,
  code_hash   text        NOT NULL,
  attempts    integer     NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_otps_mobile ON admin_otps (mobile, created_at DESC);

/*
 * THE BLOCK LIST.
 *
 * One table for both kinds, because the question asked at the door is the same
 * one — "is this blocked?" — and two tables would mean two places to forget.
 * A block is released rather than deleted, so "who blocked this number, when,
 * and who let it back in" survives.
 */
CREATE TABLE IF NOT EXISTS blocks (
  id          bigserial PRIMARY KEY,
  kind        text        NOT NULL CHECK (kind IN ('mobile', 'vehicle')),
  value       text        NOT NULL,
  reason      text,
  blocked_by  bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  released_by bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  released_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One live block per value; released ones are history and may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_live
    ON blocks (kind, value) WHERE released_at IS NULL;

INSERT INTO app_settings (key, value) VALUES
  ('admin_session_hours', '12'),
  ('admin_otp_minutes',   '10'),
  ('admin_otp_attempts',  '5'),
  -- What Razorpay keeps, so the panel can show take-home rather than turnover.
  -- UPI is nil today and cards are about 2%; both are settings because neither
  -- is ours to fix, and a wrong number here makes every revenue figure wrong.
  ('razorpay_fee_percent',     '2'),
  ('razorpay_fee_gst_percent', '18')
ON CONFLICT (key) DO NOTHING;

/* The panel's own hot paths: a day's money, a day's conversation, the funnel. */
CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON payments (paid_at DESC) WHERE status = 'paid';
CREATE INDEX IF NOT EXISTS idx_wa_messages_created ON whatsapp_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen_at DESC);
