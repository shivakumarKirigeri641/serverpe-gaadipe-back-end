-- 102_push.sql — phone notifications for the admin (src/util/push.js): each
-- browser or phone the admin switched them on in, by its push endpoint.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          bigserial   PRIMARY KEY,
  admin_id    bigint      REFERENCES admin_users(id) ON DELETE CASCADE,
  endpoint    text        NOT NULL UNIQUE,
  keys        jsonb       NOT NULL,
  device      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  failures    integer     NOT NULL DEFAULT 0
);
