-- 104_data_requests.sql — a customer asking for their personal data to be
-- deleted (DPDP Act 2023), and when it was done (src/admin/dataRequests.js).

CREATE TABLE IF NOT EXISTS data_requests (
  id          bigserial   PRIMARY KEY,
  user_id     bigint      REFERENCES users(id) ON DELETE SET NULL,
  mobile      text        NOT NULL,
  kind        text        NOT NULL DEFAULT 'delete' CHECK (kind IN ('delete')),
  status      text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'rejected')),
  said        text,
  channel     text        NOT NULL DEFAULT 'whatsapp',
  done_at     timestamptz,
  done_by     bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  note        text,
  erased      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_requests_status ON data_requests (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS data_requests_one_open ON data_requests (mobile) WHERE status = 'pending';

ALTER TABLE users ADD COLUMN IF NOT EXISTS erased_at timestamptz;
