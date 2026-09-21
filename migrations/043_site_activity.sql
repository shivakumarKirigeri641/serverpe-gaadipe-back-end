-- 043_site_activity.sql — what a signed-in customer is doing on the site
-- (user, 2026-09-21: "show full details of user signed in and currently which
-- page, vehicle, what they are checking, all must be recorded in db").
--
-- TWO PLACES, ON PURPOSE:
--
--   site_activity   the trail: every page opened and every action taken, with
--                   the session it belongs to. Append-only; this is the record.
--
--   site_sessions   carries the LATEST of each (page, vehicle, action) so the
--                   Live screen, polled every few seconds, reads one row per
--                   visitor instead of scanning the trail.

CREATE TABLE IF NOT EXISTS site_activity (
  id          bigserial PRIMARY KEY,
  session_id  bigint      REFERENCES site_sessions(id) ON DELETE CASCADE,
  user_id     bigint      REFERENCES users(id) ON DELETE CASCADE,
  kind        text        NOT NULL,             -- 'page' | 'action'
  page        text,                             -- the route, e.g. /app/vehicle/KA01AB1234
  action      text,                             -- check, view_vehicle, buy_open, pay_start, download_report, ...
  reg_no      text,
  detail      jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_activity_session ON site_activity (session_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_site_activity_user    ON site_activity (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_site_activity_created ON site_activity (created_at DESC);

ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS current_page    text;
ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS current_reg_no  text;
ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS current_action  text;
ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS current_at      timestamptz;
