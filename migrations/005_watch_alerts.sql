-- 005_watch_alerts.sql — monitoring, and proof of what was sent
--
-- MONITORING IS POLLING, AND POLLING IS THE COST. At ₹79 per 28 days the plan
-- survives roughly 22 ULIP calls per vehicle, so each dataset gets its own
-- schedule rather than one blanket interval:
--
--   challans  every 2 days  — the volatile one, and what people pay to hear
--   RC        weekly        — and skipped entirely when no expiry is near
--   FASTag    monthly       — tags change very rarely
--
-- `next_check_at` per dataset lets the job select exactly what is due instead
-- of sweeping every watch on every run, and lets a quiet vehicle be checked
-- less often than a busy one.

CREATE TABLE watches (
  id              bigserial PRIMARY KEY,
  user_id         bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id      bigint      NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  subscription_id bigint      REFERENCES subscriptions(id) ON DELETE SET NULL,
  is_active       boolean     NOT NULL DEFAULT true,
  -- Watching stops when the subscription lapses; kept here so the job does not
  -- join to subscriptions on every pass.
  expires_on      date,

  challan_next_check_at timestamptz NOT NULL DEFAULT now(),
  rc_next_check_at      timestamptz NOT NULL DEFAULT now(),
  fastag_next_check_at  timestamptz NOT NULL DEFAULT now(),
  challan_interval_hours integer NOT NULL DEFAULT 48,
  rc_interval_hours      integer NOT NULL DEFAULT 168,
  fastag_interval_hours  integer NOT NULL DEFAULT 720,

  last_checked_at timestamptz,
  -- Consecutive upstream failures. A vehicle ULIP keeps refusing should be
  -- backed off rather than retried every two days forever.
  fail_count      integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  modified_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watches_unique UNIQUE (user_id, vehicle_id)
);

-- Partial indexes: the job only ever asks for active watches that are due.
CREATE INDEX idx_watches_challan_due ON watches (challan_next_check_at) WHERE is_active;
CREATE INDEX idx_watches_rc_due      ON watches (rc_next_check_at)      WHERE is_active;
CREATE INDEX idx_watches_fastag_due  ON watches (fastag_next_check_at)  WHERE is_active;
CREATE INDEX idx_watches_user ON watches (user_id) WHERE is_active;

-- What we told someone, and whether it arrived.
--
-- Separate from vehicle_changes on purpose: a change is a fact about a vehicle,
-- an alert is a message to a person. One change may be told to several
-- watchers, or to nobody. Without this table a flaky WhatsApp send becomes
-- either silence or the same warning at 6am every day.
CREATE TABLE alerts (
  id           bigserial PRIMARY KEY,
  user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id   bigint      REFERENCES vehicles(id) ON DELETE SET NULL,
  change_id    bigint      REFERENCES vehicle_changes(id) ON DELETE SET NULL,
  kind         text        NOT NULL,          -- mirrors vehicle_changes.kind
  severity     text        NOT NULL DEFAULT 'info',
  channel      text        NOT NULL DEFAULT 'whatsapp',
  body         text,
  template_name text,
  wa_message_id text,
  status       text        NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'suppressed')),
  error_message text,
  -- Why a message was NOT sent: 'paused' (STOP), 'duplicate', 'quiet_hours',
  -- 'no_session'. A suppressed alert is still a record — silence with a reason
  -- beats no row at all when a customer asks why they were not told.
  suppressed_reason text,
  queued_at    timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  -- Stops the same warning going out daily: an insurance expiry is announced
  -- at 30, 15, 7, 3, 1 and 0 days, not every single day in between.
  dedupe_key   text,
  CONSTRAINT alerts_dedupe UNIQUE (user_id, dedupe_key)
);

CREATE INDEX idx_alerts_user ON alerts (user_id, queued_at DESC);
CREATE INDEX idx_alerts_pending ON alerts (queued_at) WHERE status = 'queued';
