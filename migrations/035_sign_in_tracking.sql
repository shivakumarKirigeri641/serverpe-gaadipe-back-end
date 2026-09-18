-- 035_sign_in_tracking.sql — every sign-in step, with the device behind it.
--
-- One row per event, never updated: a code asked for, a code refused, a wrong
-- code, a sign-in, a sign-out, a session that lapsed. Each carries the network
-- (IP and the proxy chain), the browser, OS and device parsed from the user
-- agent, what the browser itself reported (screen, time zone, languages, the
-- device model where Chrome gives it), and a device id the site keeps in the
-- browser — so one phone can be followed across numbers, and one number across
-- phones.

CREATE TABLE IF NOT EXISTS site_sign_ins (
  id              bigserial   PRIMARY KEY,
  event           text        NOT NULL,
  mobile          text,
  user_id         bigint      REFERENCES users(id) ON DELETE SET NULL,
  session_id      bigint      REFERENCES site_sessions(id) ON DELETE SET NULL,
  outcome         text,                        -- why it was refused, where it was
  device_id       text,                        -- kept by the browser, gp-…
  ip              text,
  ip_chain        text,                        -- X-Forwarded-For as received
  country         text,
  region          text,
  city            text,
  user_agent      text,
  browser         text,
  browser_version text,
  os              text,
  os_version      text,
  device_type     text,                        -- Mobile · Tablet · Desktop · Bot
  device_vendor   text,
  device_model    text,
  screen          text,                        -- 1080x2400 @3x
  viewport        text,
  timezone        text,
  languages       text,
  platform        text,
  touch_points    int,
  cpu_cores       int,
  memory_gb       numeric,
  connection      text,
  referrer        text,
  page            text,
  client          jsonb,                       -- everything the browser sent
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sign_ins_created ON site_sign_ins (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sign_ins_user    ON site_sign_ins (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sign_ins_mobile  ON site_sign_ins (mobile, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sign_ins_device  ON site_sign_ins (device_id);
CREATE INDEX IF NOT EXISTS idx_sign_ins_ip      ON site_sign_ins (ip);

ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS device_id    text;
ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS sign_in_id   bigint;
ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS ended_reason text;
ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS last_ip      text;
