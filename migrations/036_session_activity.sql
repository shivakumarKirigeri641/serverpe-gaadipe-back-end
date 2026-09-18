-- 036_session_activity.sql — how long each website visit lasted, and how busy it was.
--
-- A session already has its start (created_at), its last activity
-- (last_used_at) and its end (ended_at, ended_reason). request_count adds how
-- much was done in it: every signed-in call the site makes counts one.
--
-- Duration is start → sign-out for a session that was signed out, and
-- start → last activity for one that lapsed or is still open — a session that
-- expired three weeks later was not "open" for three weeks.

ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS request_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_site_sessions_user ON site_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_sessions_open ON site_sessions (last_used_at) WHERE ended_at IS NULL;
