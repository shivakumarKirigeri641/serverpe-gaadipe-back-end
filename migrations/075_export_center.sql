-- 075_export_center.sql — every export, logged and downloadable for a day
-- (user, 2026-09-25, operations module phase 7).
--
-- The file itself is kept here for 24 hours so it can be downloaded again
-- from the Export Center, then its content is cleared (the record stays).

CREATE TABLE IF NOT EXISTS export_jobs (
  id           bigserial   PRIMARY KEY,
  admin_id     bigint      REFERENCES admin_users(id),
  dataset      text        NOT NULL,
  filters      jsonb       NOT NULL DEFAULT '{}',
  records      int,
  status       text        NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'failed', 'expired')),
  file_name    text,
  content      bytea,
  size_bytes   int,
  error        text,
  masked       boolean,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  downloads    int         NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS export_jobs_created_idx ON export_jobs (created_at DESC);
