-- 085_fleet_enquiries.sql — fleet owners asking for GaadiPe Fleet (user,
-- 2026-09-29). Tapping "For fleets" in WhatsApp makes a row with a one-time
-- link; the form behind it fills the row and emails it to fleet_enquiry_emails
-- (support@gaadipe.in). The table is the record of every lead.

CREATE TABLE IF NOT EXISTS fleet_enquiries (
  id            bigserial   PRIMARY KEY,
  token         text        NOT NULL UNIQUE,
  user_id       bigint      REFERENCES users(id) ON DELETE SET NULL,
  mobile        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  submitted_at  timestamptz,
  company       text,
  contact_name  text,
  email         text,
  vehicles      int,
  vehicle_list  text,
  city          text,
  gstin         text,
  message       text,
  ip            text,
  user_agent    text,
  emailed_at    timestamptz,
  email_error   text
);
CREATE INDEX IF NOT EXISTS fleet_enquiries_submitted_idx ON fleet_enquiries (submitted_at DESC);

INSERT INTO app_settings (key, value) VALUES
  ('fleet_enquiry_emails', 'support@gaadipe.in'),
  ('fleet_link_hours',     '48')
ON CONFLICT (key) DO NOTHING;
