-- 070_vehicle_console.sql — the admin Vehicles module (user, 2026-09-25).
--
-- Everything the module shows about a vehicle is already stored: vehicles
-- (one row per normalised registration number — the "normalized_vehicle_number";
-- the display form is computed by plate.pretty, never stored twice),
-- vehicle_snapshots (every field the provider returned: RC, challans, FASTag),
-- api_calls, events, vehicle_reports, payments (raw.vehicle_id), user_vehicles
-- and admin_audit. What is added here is only what admins themselves create —
-- notes, tags, lists, assignment, saved layouts — and the indexes the explorer
-- needs to answer quickly by vehicle.

-- Notes are never overwritten: an edit keeps the text it replaced, and a note
-- is withdrawn rather than deleted.
CREATE TABLE IF NOT EXISTS vehicle_notes (
  id            bigserial   PRIMARY KEY,
  vehicle_id    bigint      NOT NULL REFERENCES vehicles(id),
  admin_id      bigint      REFERENCES admin_users(id),
  body          text        NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  edited_at     timestamptz,
  withdrawn_at  timestamptz,
  withdrawn_by  bigint      REFERENCES admin_users(id)
);
CREATE INDEX IF NOT EXISTS vehicle_notes_vehicle_idx ON vehicle_notes (vehicle_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vehicle_note_versions (
  id          bigserial   PRIMARY KEY,
  note_id     bigint      NOT NULL REFERENCES vehicle_notes(id),
  body        text        NOT NULL,         -- the text as it was before this edit
  admin_id    bigint      REFERENCES admin_users(id),
  replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_note_versions_note_idx ON vehicle_note_versions (note_id);

-- Internal tags: "important", "follow_up", "api_issue", … — admin only.
CREATE TABLE IF NOT EXISTS vehicle_tags (
  vehicle_id  bigint      NOT NULL REFERENCES vehicles(id),
  tag         text        NOT NULL CHECK (tag ~ '^[a-z0-9_]{2,24}$'),
  added_by    bigint      REFERENCES admin_users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vehicle_id, tag)
);
CREATE INDEX IF NOT EXISTS vehicle_tags_tag_idx ON vehicle_tags (tag);

-- Saved lists ("Follow-up vehicles", "API failures", …), shared by the team.
CREATE TABLE IF NOT EXISTS vehicle_lists (
  id          bigserial   PRIMARY KEY,
  name        text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  notes       text,
  created_by  bigint      REFERENCES admin_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  modified_at timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE TABLE IF NOT EXISTS vehicle_list_items (
  list_id     bigint      NOT NULL REFERENCES vehicle_lists(id),
  vehicle_id  bigint      NOT NULL REFERENCES vehicles(id),
  note        text,
  added_by    bigint      REFERENCES admin_users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, vehicle_id)
);
CREATE INDEX IF NOT EXISTS vehicle_list_items_vehicle_idx ON vehicle_list_items (vehicle_id);

-- Who on the team is looking after a vehicle, and whether it is archived out
-- of the operational views. Archiving hides; it never deletes anything.
CREATE TABLE IF NOT EXISTS vehicle_admin (
  vehicle_id   bigint      PRIMARY KEY REFERENCES vehicles(id),
  assigned_to  bigint      REFERENCES admin_users(id),
  assigned_by  bigint      REFERENCES admin_users(id),
  assigned_at  timestamptz,
  archived_at  timestamptz,
  archived_by  bigint      REFERENCES admin_users(id)
);

-- Per-admin preferences: the explorer's columns, their order and widths, and
-- saved filters. Kept on the server so they follow the admin between browsers.
CREATE TABLE IF NOT EXISTS admin_preferences (
  admin_id    bigint      NOT NULL REFERENCES admin_users(id),
  key         text        NOT NULL CHECK (key ~ '^[a-z0-9_.-]{1,60}$'),
  value       jsonb       NOT NULL,
  modified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (admin_id, key)
);

-- Answering "everything about this vehicle" quickly.
CREATE INDEX IF NOT EXISTS events_reg_idx       ON events (reg_no, occurred_at) WHERE reg_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_payment_idx   ON events (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_api_calls_reg    ON api_calls (reg_no, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_vehicle ON payments ((raw->>'vehicle_id')) WHERE raw ? 'vehicle_id';

-- Tunable from Settings: when a document counts as "expiring soon", and the
-- thresholds the vehicle signals use. Signals only ever list; they never act.
INSERT INTO app_settings (key, value) VALUES
  ('vehicle_expiring_days',            '30'),   -- documents expiring within this many days
  ('signal_vehicles_per_person_day',   '10'),   -- one number, this many vehicles in a day
  ('signal_lookups_per_vehicle_hour',  '5'),    -- one vehicle, this many lookups in an hour
  ('signal_mobiles_per_device',        '2'),    -- one browser, this many WhatsApp numbers
  ('signal_payment_failures_day',      '3'),    -- one customer, this many failed payments in a day
  ('signal_api_calls_per_person_hour', '30')    -- one customer, this many live API calls in an hour
ON CONFLICT (key) DO NOTHING;
