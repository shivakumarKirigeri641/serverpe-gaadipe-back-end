-- 116_rc_backup_no_pause.sql (user, 2026-10-05: "remove that pause, customer
-- will scold me"). The RC backup no longer pauses itself after failures; any
-- pause left over is cleared. rc_backup_auto_pause = true would bring it back.

INSERT INTO app_settings (key, value) VALUES ('rc_backup_auto_pause', 'false')
ON CONFLICT (key) DO NOTHING;

UPDATE app_settings SET value = '', modified_at = now() WHERE key = 'rc_backup_paused_until';
