-- 002_vehicle_data.sql — the cache, the diff, and the cost ledger
--
-- These three tables are why GaadiPe can charge money.
--
--   vehicle_snapshots — what we last saw. Serving a repeat lookup from here
--                       instead of ULIP is the entire margin once ULIP starts
--                       charging.
--   vehicle_changes   — what CHANGED. This is the product: a customer does not
--                       pay to look a vehicle up (the government site is free),
--                       they pay to be TOLD. Without a previous snapshot you
--                       cannot tell a new challan from an old one, and the old
--                       system's "last_challan_count" integer could only say
--                       "the number moved" — never which challan, for what,
--                       or how much.
--   api_calls         — every ULIP request, attributed to a user. Cost per
--                       customer becomes a query rather than a guess.

CREATE TABLE vehicle_snapshots (
  id           bigserial PRIMARY KEY,
  vehicle_id   bigint      NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  -- Our names, not ULIP's dataset codes, so a provider change never rewrites
  -- this table.
  dataset      text        NOT NULL CHECK (dataset IN ('rc', 'challan', 'fastag')),
  data         jsonb       NOT NULL,          -- normalised, what the app uses
  -- The untouched gateway response. Kept because ULIP's shapes drift, and when
  -- a mapping turns out wrong we can re-derive without paying for the call
  -- again — exactly what happened with the offence object.
  raw          jsonb,
  source       text,                          -- 'VAHAN/04', 'VAHAN/01', …
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  -- Staleness horizon written at fetch time, so a cache read is one indexed
  -- comparison with no application logic.
  expires_at   timestamptz NOT NULL,
  CONSTRAINT vehicle_snapshots_unique UNIQUE (vehicle_id, dataset)
);

CREATE INDEX idx_snapshots_expiry ON vehicle_snapshots (dataset, expires_at);

CREATE TABLE vehicle_changes (
  id           bigserial PRIMARY KEY,
  vehicle_id   bigint      NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  dataset      text        NOT NULL,
  -- new_challan | challan_cleared | insurance_expiring | insurance_expired
  -- pucc_expiring | fitness_expiring | tax_expiring | permit_expiring
  -- fastag_inactive | fastag_activated | blacklisted | owner_changed
  -- financer_added | financer_cleared | rc_status_changed
  kind         text        NOT NULL,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  severity     text        NOT NULL DEFAULT 'info'
               CHECK (severity IN ('info', 'warning', 'critical')),
  detected_at  timestamptz NOT NULL DEFAULT now(),
  -- A change is not the same as a message. One change may be told to several
  -- watchers, or to none if nobody is watching.
  CONSTRAINT vehicle_changes_dedupe UNIQUE (vehicle_id, kind, detail, detected_at)
);

CREATE INDEX idx_changes_vehicle ON vehicle_changes (vehicle_id, detected_at DESC);
CREATE INDEX idx_changes_unsent ON vehicle_changes (detected_at DESC) WHERE severity <> 'info';

CREATE TABLE api_calls (
  id             bigserial PRIMARY KEY,
  user_id        bigint      REFERENCES users(id) ON DELETE SET NULL,
  vehicle_id     bigint      REFERENCES vehicles(id) ON DELETE SET NULL,
  reg_no         text,
  dataset        text        NOT NULL,
  provider_path  text,                        -- 'VAHAN/04'; null on a cache hit
  -- Hits are recorded too (billable = false) so hit-rate is measurable —
  -- without it you cannot tell a cheap customer from an expensive one.
  cache_hit      boolean     NOT NULL DEFAULT false,
  http_status    integer,
  -- ULIP answers 200 with a FAILED payload inside, so transport success and
  -- data success are two different questions and both are recorded.
  ok             boolean     NOT NULL DEFAULT false,
  outcome        text,                        -- FOUND | NOT_FOUND | RETRY | REJECTED
  error_code     text,
  error_message  text,
  duration_ms    integer,
  -- Unknown today (ULIP is free) but the column exists now so history is
  -- complete the day they start charging.
  cost_paise     integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_calls_user_day ON api_calls (user_id, created_at DESC);
CREATE INDEX idx_api_calls_dataset ON api_calls (dataset, created_at DESC);
CREATE INDEX idx_api_calls_billable ON api_calls (created_at DESC) WHERE NOT cache_hit;
