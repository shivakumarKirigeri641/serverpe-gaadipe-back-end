-- 130_account_changes.sql (user, 2026-10-07) — the customer's account, changed
-- by the customer, with the admin deciding what moves.
--
-- ARCHIVED ON DEACTIVATION: the account keeps every row (vehicles, reports,
-- payments, invoices — the admin sees them all) but its mobile is set aside
-- ("a<id>-<mobile>"), so signing in again with that number starts a NEW, empty
-- account. archived_mobile keeps the number as it was.
ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_at     timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_mobile text;

-- A CHANGE OF MOBILE: the customer verifies the new number with its code and is
-- signed in on it; their old number's vehicles and reports stay with the old
-- account unless they ask for a transfer, which the admin approves or rejects
-- (each answered by email).
CREATE TABLE IF NOT EXISTS account_transfers (
  id            bigserial   PRIMARY KEY,
  from_user_id  bigint      NOT NULL REFERENCES users(id),
  to_user_id    bigint      NOT NULL REFERENCES users(id),
  from_mobile   text        NOT NULL,
  to_mobile     text        NOT NULL,
  note          text,                                -- what the customer wrote
  status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_id      bigint,
  admin_note    text,
  moved         jsonb,                               -- what was moved on approval
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_transfers_status_idx ON account_transfers (status, created_at DESC);

-- A SIX-DIGIT CODE BY EMAIL: an address is confirmed inside the payment window
-- (checkout needs a verified email) without leaving it for a link.
CREATE TABLE IF NOT EXISTS email_codes (
  id           bigserial   PRIMARY KEY,
  user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email        text        NOT NULL,
  code_hash    text        NOT NULL,
  attempts     integer     NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_codes_user_idx ON email_codes (user_id, created_at DESC);

-- What an email broadcast is: promotion (only to people who opted in to tips &
-- offers), or an alert / notification / service message (every confirmed address).
ALTER TABLE admin_email_campaigns ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'service';

INSERT INTO app_settings (key, value) VALUES
  ('rcs_enabled', 'false')     -- RCS messaging: a placeholder until a provider is set up
ON CONFLICT (key) DO NOTHING;
