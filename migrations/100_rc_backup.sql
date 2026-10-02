-- 100_rc_backup.sql — the paid RC backup used only when ULIP's VAHAN fails
-- (src/vehicle/rcBackup.js). Off until the rc_backup flag is switched on and
-- RC_BACKUP_URL / RC_BACKUP_KEY are set on the server.

INSERT INTO app_settings (key, value) VALUES
  ('rc_backup_cost_paise',  '300'),
  ('rc_backup_daily_limit', '200')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS event_log_rc_backup_day ON event_log (created_at) WHERE kind = 'rc_backup_call';
