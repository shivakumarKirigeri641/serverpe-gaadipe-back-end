-- 123_customer_push.sql (user, 2026-10-07: "after sign in, ask for browser
-- notifications"). Each browser or installed app where a CUSTOMER allowed
-- GaadiPe notifications (src/site/push.js). Kept apart from the admin's
-- push_subscriptions on purpose: the admin feed sends to every row of that
-- table, and a customer must never receive the admin's alerts.

CREATE TABLE IF NOT EXISTS customer_push_subscriptions (
  id          bigserial   PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text        NOT NULL UNIQUE,
  keys        jsonb       NOT NULL,
  device      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  failures    integer     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_customer_push_user ON customer_push_subscriptions (user_id);
