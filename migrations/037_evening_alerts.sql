-- 037_evening_alerts.sql — one alert per mobile, once a day, in the evening.
--
-- The watch job still re-checks vehicles through the day, but what it finds is
-- queued here rather than sent. Each evening (19:00 IST by default) every
-- mobile with something queued gets ONE message covering all its vehicles:
-- new challans, documents newly expiring, documents newly expired. A finding is
-- queued once per watch (its key), so nothing is repeated on later days.

CREATE TABLE IF NOT EXISTS pending_alerts (
  id          bigserial   PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watch_id    bigint      NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  vehicle_id  bigint      NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  reg_no      text        NOT NULL,
  key         text        NOT NULL,
  label       text        NOT NULL,
  text        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  CONSTRAINT pending_alerts_once UNIQUE (watch_id, key)
);

CREATE INDEX IF NOT EXISTS idx_pending_alerts_unsent ON pending_alerts (user_id) WHERE sent_at IS NULL;

INSERT INTO app_settings (key, value) VALUES
  ('alert_send_hour_ist', '19'),        -- the evening send starts at 7 pm IST
  ('alert_send_until_hour_ist', '22')   -- and never goes out after 10 pm
ON CONFLICT (key) DO NOTHING;
