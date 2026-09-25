-- 074_flags_tasks_audit.sql — feature switches, tasks and notes, and an audit
-- trail nobody can rewrite (user, 2026-09-25, operations module phase 6).

-- Feature switches (src/util/flags.js). On, as GaadiPe runs today.
INSERT INTO app_settings (key, value) VALUES
  ('flag_whatsapp_flow',     'true'),
  ('flag_website_flow',      'true'),
  ('flag_payments',          'true'),
  ('flag_vehicle_api',       'true'),
  ('flag_report_generation', 'true'),
  ('maintenance_mode',       'false'),
  -- Alerts muted by rule, as JSON {"rule_key": "until ISO time"}.
  ('alerts_muted',           '{}')
ON CONFLICT (key) DO NOTHING;

-- Tasks: a piece of work for someone on the team, optionally about a
-- customer, vehicle, payment or incident.
CREATE TABLE IF NOT EXISTS admin_tasks (
  id            bigserial   PRIMARY KEY,
  title         text        NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description   text,
  entity_type   text        CHECK (entity_type IN ('customer', 'vehicle', 'payment', 'incident')),
  entity_id     text,
  assigned_to   bigint      REFERENCES admin_users(id),
  priority      text        NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_date      date,
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  created_by    bigint      REFERENCES admin_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS admin_tasks_status_idx ON admin_tasks (status, due_date);
CREATE INDEX IF NOT EXISTS admin_tasks_entity_idx ON admin_tasks (entity_type, entity_id);

-- Notes on a customer, payment or incident (vehicles keep theirs in
-- vehicle_notes). Append-only: a note is withdrawn, never edited or deleted.
CREATE TABLE IF NOT EXISTS entity_notes (
  id            bigserial   PRIMARY KEY,
  entity_type   text        NOT NULL CHECK (entity_type IN ('customer', 'payment', 'incident')),
  entity_id     text        NOT NULL,
  admin_id      bigint      REFERENCES admin_users(id),
  body          text        NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz,
  withdrawn_by  bigint      REFERENCES admin_users(id)
);
CREATE INDEX IF NOT EXISTS entity_notes_entity_idx ON entity_notes (entity_type, entity_id, created_at DESC);

-- THE AUDIT TRAIL CANNOT BE REWRITTEN. No screen or route edits it; this makes
-- the database refuse too. (Whoever owns the database can still drop the
-- trigger — that is a server-access question, not a panel one.)
CREATE OR REPLACE FUNCTION admin_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit is append-only';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS admin_audit_immutable ON admin_audit;
CREATE TRIGGER admin_audit_immutable BEFORE UPDATE OR DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION admin_audit_immutable();

CREATE INDEX IF NOT EXISTS admin_audit_action_idx ON admin_audit (action, id DESC);
CREATE INDEX IF NOT EXISTS admin_audit_admin_idx  ON admin_audit (admin_id, id DESC);
