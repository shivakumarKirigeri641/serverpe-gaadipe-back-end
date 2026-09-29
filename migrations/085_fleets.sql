-- 085_fleets.sql — GaadiPe for fleets (user, 2026-09-29).
--
-- A fleet owner emails support@gaadipe.in with their vehicle list; the admin
-- creates the fleet here, sends a quotation with a payment link, and approves
-- it once paid. From then on every vehicle is checked daily and one email a
-- day carries an Excel of the whole fleet. Everything is by email — no login,
-- no WhatsApp messages to the fleet. src/fleet/*.

CREATE TABLE IF NOT EXISTS fleets (
  id            bigserial   PRIMARY KEY,
  company       text        NOT NULL,
  contact_name  text,
  email         text        NOT NULL,          -- where the daily report goes
  cc_emails     text,                          -- more recipients, comma-separated
  gstin         text,
  mobile        text,
  state_code    text,                          -- GST place of supply (two digits)
  status        text        NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'quoted', 'paid', 'active', 'expired', 'paused', 'cancelled')),
  notes         text,
  starts_at     timestamptz,
  ends_at       timestamptz,
  approved_at   timestamptz,
  approved_by   bigint      REFERENCES admin_users(id),
  created_by    bigint      REFERENCES admin_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  modified_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleets_status_idx ON fleets (status);

-- A vehicle stays on the fleet until it is removed; a removed one keeps its row
-- (removed_at), so the history of what was covered survives.
CREATE TABLE IF NOT EXISTS fleet_vehicles (
  id               bigserial   PRIMARY KEY,
  fleet_id         bigint      NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  reg_no           text        NOT NULL,
  vehicle_id       bigint      REFERENCES vehicles(id),
  added_at         timestamptz NOT NULL DEFAULT now(),
  removed_at       timestamptz,
  last_checked_at  timestamptz,
  last_attempt_at  timestamptz,
  last_check_ok    boolean,
  last_error       text
);
CREATE UNIQUE INDEX IF NOT EXISTS fleet_vehicles_one_live ON fleet_vehicles (fleet_id, reg_no) WHERE removed_at IS NULL;

-- Every quotation and renewal: a Razorpay payment link, and what it bought.
CREATE TABLE IF NOT EXISTS fleet_payments (
  id                   bigserial   PRIMARY KEY,
  fleet_id             bigint      NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  kind                 text        NOT NULL DEFAULT 'new' CHECK (kind IN ('new', 'renewal')),
  amount_paise         integer     NOT NULL CHECK (amount_paise > 0),
  vehicles             integer     NOT NULL,
  period_days          integer     NOT NULL,
  link_id              text,
  link_url             text,
  status               text        NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'expired', 'cancelled')),
  razorpay_payment_id  text,
  paid_at              timestamptz,
  expires_at           timestamptz,
  invoice_id           bigint,
  created_by           bigint      REFERENCES admin_users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleet_payments_fleet_idx ON fleet_payments (fleet_id, created_at DESC);

-- One report per fleet per IST day. `snapshot` is what each vehicle looked
-- like, so tomorrow's email can say what changed.
CREATE TABLE IF NOT EXISTS fleet_reports (
  id          bigserial   PRIMARY KEY,
  fleet_id    bigint      NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  ist_date    date        NOT NULL,
  status      text        NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  sent_to     text,
  error       text,
  vehicles    integer,
  snapshot    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fleet_id, ist_date)
);

-- Everything that happened to a fleet, in order — the admin panel's timeline.
CREATE TABLE IF NOT EXISTS fleet_events (
  id        bigserial   PRIMARY KEY,
  fleet_id  bigint      NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  kind      text        NOT NULL,
  text      text        NOT NULL,
  detail    jsonb       NOT NULL DEFAULT '{}',
  admin_id  bigint      REFERENCES admin_users(id)
);
CREATE INDEX IF NOT EXISTS fleet_events_fleet_idx ON fleet_events (fleet_id, at DESC);

-- A fleet's GST invoice has no customer account behind it.
ALTER TABLE invoices ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fleet_payment_id bigint REFERENCES fleet_payments(id);

INSERT INTO app_settings (key, value) VALUES
  ('fleet_price_per_vehicle_paise', '1900'),  -- the quotation's suggestion: count × ₹19 (GST included)
  ('fleet_period_days',             '28'),
  ('fleet_min_vehicles',            '5'),
  ('fleet_link_days',               '7'),     -- how long a quotation's payment link works
  ('fleet_renewal_notice_days',     '3'),
  ('fleet_report_hour_ist',         '19'),    -- the daily Excel email: from 7 pm…
  ('fleet_report_until_hour_ist',   '22')     -- …and never after 10 pm
ON CONFLICT (key) DO NOTHING;
