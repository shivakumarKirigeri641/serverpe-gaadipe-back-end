-- 128_web_controls.sql — THE WEB ADMIN'S CONTROLS (user, 2026-10-07; spec §40,
-- §70–72, §86–90, §97, §113–114). Every action is written to admin_audit.
--
-- web_sessions.device_key: the browser's sign-in device id (the site's
-- "gaadipe.device", the same value site_sessions.device_id holds), sent with the
-- heartbeat — so ending a visit ends exactly that browser's sign-in, no other.
-- customer_flags: an admin's marker on a customer (fraud, VIP, follow up…),
-- with a reason; cleared, never deleted.

ALTER TABLE web_sessions ADD COLUMN IF NOT EXISTS device_key text;
CREATE INDEX IF NOT EXISTS web_sessions_device_key_idx ON web_sessions (device_key);

CREATE TABLE IF NOT EXISTS customer_flags (
  id          bigserial   PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flag        text        NOT NULL,              -- follow_up | vip | suspicious | blocked_support | other
  reason      text,
  admin_id    bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  cleared_at  timestamptz,
  cleared_by  bigint
);
CREATE INDEX IF NOT EXISTS customer_flags_user_idx ON customer_flags (user_id) WHERE cleared_at IS NULL;

INSERT INTO app_settings (key, value) VALUES
  ('web_track_scroll',               'on'),   -- scroll depth in the heartbeat (on | off)
  ('web_interaction_retention_days', '90')    -- 'interaction' events kept this long
ON CONFLICT (key) DO NOTHING;
