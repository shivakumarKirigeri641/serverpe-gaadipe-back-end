-- 126_web_sessions.sql — LIVE CUSTOMERS ON THE WEBSITE (user, 2026-10-07: the
-- web admin's "who is online right now, on which step"; spec §6–8, §67–70, §83–85).
--
-- One row per website visit (a browser tab's session id, made by the page —
-- src/lib/track.js in the site). The page sends a light HEARTBEAT every ~20 s
-- while it is open — page, journey step, section on screen, scroll depth, and
-- whether the tab is visible — and each meaningful tap. Presence is read from
-- here: ONLINE (heard within 45 s, tab visible), IDLE (no tap for a minute),
-- HIDDEN (tab in the background), OFFLINE (no heartbeat). Nothing typed is ever
-- sent, only which field has focus; the sign-in code field is "protected".
-- Heartbeats update this row only — they are not written to `events`.

CREATE TABLE IF NOT EXISTS web_sessions (
  session_id     text        PRIMARY KEY,               -- the page's own random id (s_…)
  visitor_id     text        NOT NULL,                  -- the browser (v_…), kept across visits
  user_id        bigint      REFERENCES users(id) ON DELETE SET NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),    -- the last heartbeat or event
  last_action_at timestamptz,                           -- the last real interaction
  ended_at       timestamptz,
  end_reason     text,                                  -- left | terminated | signed_out
  page           text,
  step           text,                                  -- welcome | checking | signing_in | code | viewing | paying | …
  action         text,                                  -- the last interaction, in words
  section        text,                                  -- what is on screen: vehicle card, full report, profile…
  scroll_pct     integer,
  visible        boolean     NOT NULL DEFAULT true,
  pages          integer     NOT NULL DEFAULT 0,
  interactions   integer     NOT NULL DEFAULT 0,
  beats          integer     NOT NULL DEFAULT 0,
  source         text,
  campaign       text,
  landing        text,
  device         jsonb       NOT NULL DEFAULT '{}',
  place          jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS web_sessions_seen_idx    ON web_sessions (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS web_sessions_user_idx    ON web_sessions (user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS web_sessions_visitor_idx ON web_sessions (visitor_id, last_seen_at DESC);

-- Optional interaction monitoring, switched off per session, customer, device
-- (browser) or everywhere (spec §70–71, §97). Core events — sign-in, checks,
-- payments — are always recorded; this governs only the extra telemetry.
CREATE TABLE IF NOT EXISTS monitoring_controls (
  id          bigserial   PRIMARY KEY,
  scope       text        NOT NULL CHECK (scope IN ('session', 'customer', 'device', 'global')),
  ref         text        NOT NULL DEFAULT '',             -- session id, user id, visitor id; '' for global
  disabled    boolean     NOT NULL DEFAULT true,
  reason      text,
  admin_id    bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  lifted_at   timestamptz,
  lifted_by   bigint
);
CREATE INDEX IF NOT EXISTS monitoring_controls_open_idx ON monitoring_controls (scope, ref) WHERE lifted_at IS NULL;

INSERT INTO app_settings (key, value) VALUES
  ('web_idle_seconds',           '60'),   -- no tap for this long: IDLE
  ('web_offline_seconds',        '75'),   -- no heartbeat for this long: OFFLINE
  ('web_monitoring',             'on'),   -- optional interaction telemetry, everywhere (on | off)
  ('web_session_retention_days', '180')   -- web_sessions rows kept this long
ON CONFLICT (key) DO NOTHING;
