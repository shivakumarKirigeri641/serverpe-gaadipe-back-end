-- 073_jobs_backups_infra.sql — job history, backups and the thresholds the
-- infrastructure checks use (user, 2026-09-25, operations module phase 5).

-- Every run of every background job, kept a week: when, how long, how much it
-- did, and the error if it failed. The in-memory heartbeat says what is
-- happening now; this says what happened, across restarts.
CREATE TABLE IF NOT EXISTS job_runs (
  id           bigserial   PRIMARY KEY,
  job          text        NOT NULL,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  duration_ms  int,
  status       text        NOT NULL CHECK (status IN ('running', 'success', 'failed', 'paused')),
  processed    int,
  error        text,
  trigger      text        NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual')),
  admin_id     bigint      REFERENCES admin_users(id)
);
CREATE INDEX IF NOT EXISTS job_runs_job_idx  ON job_runs (job, started_at DESC);
CREATE INDEX IF NOT EXISTS job_runs_time_idx ON job_runs (started_at);

-- Database backups made on the server by the scheduled job (off by default —
-- see backup_scheduled_enabled). Downloads from the panel are in admin_audit.
CREATE TABLE IF NOT EXISTS backups (
  id           bigserial   PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed', 'deleted')),
  file_name    text,
  size_bytes   bigint,
  error        text,
  trigger      text        NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual')),
  admin_id     bigint      REFERENCES admin_users(id)
);
CREATE INDEX IF NOT EXISTS backups_started_idx ON backups (started_at DESC);

INSERT INTO app_settings (key, value) VALUES
  -- Backups written on this server by the app. Off: the panel's download (owner
  -- only, audited) leaves no copy on the server, and that stays the default.
  ('backup_scheduled_enabled',       'false'),
  ('backup_hour_ist',                '2'),
  ('backup_retention_days',          '7'),
  ('alert_backup_stale_hours',       '168'),  -- no backup (download or scheduled) for a week
  ('alert_disk_pct',                 '80'),
  ('alert_memory_pct',               '90'),
  ('alert_ssl_days',                 '14'),
  ('alert_domain_days',              '30'),
  ('jobs_paused',                    ''),     -- comma-separated job names
  ('job_runs_keep_days',             '7'),
  -- WhatsApp cost per business message by Meta category, in paise (from Meta's rate card / invoice).
  ('whatsapp_cost_paise_utility',        '11'),
  ('whatsapp_cost_paise_authentication', '11')
ON CONFLICT (key) DO NOTHING;
