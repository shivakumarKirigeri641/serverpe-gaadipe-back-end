-- 001_core.sql — people, vehicles, and who cares about which
--
-- Identity is the MOBILE NUMBER. GaadiPe is reached over WhatsApp, so the
-- number is how a person is known, how they are billed, and how they are
-- messaged. There are no passwords and no usernames.
--
-- A vehicle exists once, globally. Several people may look at the same
-- registration — two dealers considering the same car, a buyer and a seller —
-- so ownership is a separate relation, and one cached snapshot serves them all.

CREATE TABLE users (
  id                bigserial PRIMARY KEY,
  -- Ten digits, no country code, normalised on the way in so the same person
  -- cannot arrive twice as '9886122415' and '+919886122415'.
  mobile            text        NOT NULL UNIQUE
                    CHECK (mobile ~ '^[0-9]{10}$'),
  name              text,
  email             text,
  -- WhatsApp's own id for this contact, and the display name it reports.
  wa_id             text,
  wa_profile_name   text,
  state_code        text,
  -- 'whatsapp' | 'web' | 'partner' | 'admin' — where they arrived from.
  signup_channel    text        NOT NULL DEFAULT 'whatsapp',
  -- Which partner brought them, if any. Set once, never reassigned: the
  -- partner keeps earning on this customer's renewals.
  referred_by       bigint,
  referral_code_used text,
  -- The founder's own number should not distort customer analytics.
  is_internal       boolean     NOT NULL DEFAULT false,
  -- STOP on WhatsApp pauses every outbound message, not just marketing.
  is_paused         boolean     NOT NULL DEFAULT false,
  paused_at         timestamptz,
  is_active         boolean     NOT NULL DEFAULT true,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  modified_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_referred_by ON users (referred_by) WHERE referred_by IS NOT NULL;
CREATE INDEX idx_users_active ON users (last_seen_at DESC) WHERE is_active;

CREATE TABLE vehicles (
  id            bigserial PRIMARY KEY,
  -- Already normalised: uppercase, alphanumeric only. ULIP enforces
  -- ^[A-Z0-9]{5,11}$ and rejects anything else with a 400, so we validate
  -- before spending a call rather than after.
  reg_no        text        NOT NULL UNIQUE
                CHECK (reg_no ~ '^[A-Z0-9]{5,11}$'),
  -- Denormalised display fields, refreshed on each RC fetch, so a list of
  -- fifty vehicles renders without opening fifty JSON snapshots.
  maker         text,
  model         text,
  fuel          text,
  vehicle_class text,
  reg_date      date,
  -- Cheap answers to "is anything about to lapse?" without parsing JSON.
  insurance_upto date,
  pucc_upto      date,
  fitness_upto   date,
  tax_upto       date,
  permit_upto    date,
  -- The four a used-car buyer is paying to see, kept queryable.
  owner_serial   integer,
  financer       text,
  blacklist_status text,
  rc_status      text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_vehicles_expiry ON vehicles (insurance_upto, pucc_upto, fitness_upto);

-- Which people care about which vehicles, and why.
CREATE TABLE user_vehicles (
  id          bigserial PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id  bigint      NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  -- 'owned'    their own vehicle
  -- 'prospect' considering buying it
  -- 'checked'  looked up once, no ongoing interest
  relation    text        NOT NULL DEFAULT 'checked'
              CHECK (relation IN ('owned', 'prospect', 'checked')),
  label       text,                      -- "Dad's scooter", "Bus 14"
  check_count integer     NOT NULL DEFAULT 1,
  first_checked_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_vehicles_unique UNIQUE (user_id, vehicle_id)
);

CREATE INDEX idx_user_vehicles_user ON user_vehicles (user_id, relation);

-- One place to answer "what happened for this customer?" without joining six
-- tables. Deliberately append-only and schemaless in the detail column.
CREATE TABLE event_log (
  id          bigserial PRIMARY KEY,
  user_id     bigint      REFERENCES users(id) ON DELETE SET NULL,
  vehicle_id  bigint      REFERENCES vehicles(id) ON DELETE SET NULL,
  kind        text        NOT NULL,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_event_log_user ON event_log (user_id, created_at DESC);
CREATE INDEX idx_event_log_kind ON event_log (kind, created_at DESC);

CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  modified_at timestamptz NOT NULL DEFAULT now()
);
