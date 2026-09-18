-- 041_security.sql — the encrypted API, rate limits, and a record of misbehaviour.
--
-- security_events: every time something looked wrong — too many requests from
-- one address, the same call in a loop, a scraping pattern, an automation tool,
-- a request that tried to skip the encryption, a message that failed to decrypt
-- or was replayed. The admin is emailed (batched, see notify_security) and the
-- panel lists them.

CREATE TABLE IF NOT EXISTS security_events (
  id          bigserial   PRIMARY KEY,
  kind        text        NOT NULL,     -- rate_limit | loop | scraping | bot | plain_request | bad_envelope | replay | blocked_ip
  severity    text        NOT NULL DEFAULT 'warn',   -- info | warn | high
  surface     text,                     -- site | admin | gateway
  ip          text,
  user_id     bigint      REFERENCES users(id) ON DELETE SET NULL,
  mobile      text,
  path        text,
  user_agent  text,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_ip ON security_events (ip, created_at DESC);

INSERT INTO app_settings (key, value) VALUES
  -- 'auto' = required in production, optional in development (plain HTTP on a
  -- phone has no Web Crypto, so it cannot encrypt). 'true' / 'false' force it.
  ('api_encryption_required', 'auto'),
  ('rate_limit_per_minute_ip', '150'),       -- site/admin API calls per IP per minute
  ('rate_limit_handshakes_per_minute_ip', '20'),
  ('loop_limit_same_call_30s', '15'),        -- the same call, same body, within 30 seconds
  ('scrape_distinct_vehicles_per_hour_user', '40'),
  ('scrape_distinct_vehicles_per_hour_ip', '60'),
  ('block_automation_tools', 'true'),        -- curl, Python, headless browsers… on the site API
  ('temp_block_minutes', '30'),              -- how long an IP that crossed a line is refused
  ('notify_security', 'true'),
  ('security_alert_cooldown_minutes', '15')  -- at most one security email per this many minutes
ON CONFLICT (key) DO NOTHING;
