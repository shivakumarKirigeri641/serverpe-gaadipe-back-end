-- 052_whatsapp_broadcasts.sql — broadcasting an approved template (user, 2026-09-23).
--
-- Outside the 24-hour window an approved template is the ONLY thing that will
-- deliver, so a broadcast is a template plus a list of people plus how each
-- {{n}} is filled for each of them.
--
-- TWO TABLES, THE SAME SHAPE AS admin_email_campaigns: the broadcast is what
-- the admin asked for, one target row per person is what actually happened.
-- The resolved parameters are stored on the target, not recomputed at send
-- time, so what a customer was sent is on record even after they check another
-- vehicle and their "last vehicle" changes.

CREATE TABLE IF NOT EXISTS whatsapp_broadcasts (
  id            bigserial PRIMARY KEY,
  admin_id      bigint,
  template_name text        NOT NULL,
  language      text        NOT NULL DEFAULT 'en',
  -- How each body variable is filled: ["first_name", "last_vehicle", ...] or
  -- {"3": "literal text"}. Kept so a broadcast can be read back and repeated.
  variables     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  note          text,
  status        text        NOT NULL DEFAULT 'queued',  -- queued | sent | cancelled
  recipients    integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE TABLE IF NOT EXISTS whatsapp_broadcast_targets (
  id            bigserial PRIMARY KEY,
  broadcast_id  bigint      NOT NULL REFERENCES whatsapp_broadcasts(id) ON DELETE CASCADE,
  user_id       bigint      REFERENCES users(id) ON DELETE CASCADE,
  mobile        text        NOT NULL,
  -- The parameters exactly as they went to Meta, in order.
  params        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status        text        NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  error         text,
  attempts      integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);

-- One message per person per broadcast, whatever a retry or a double click does.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_broadcast_target_once
    ON whatsapp_broadcast_targets (broadcast_id, mobile);
CREATE INDEX IF NOT EXISTS idx_wa_broadcast_target_pending
    ON whatsapp_broadcast_targets (broadcast_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_wa_broadcast_recent
    ON whatsapp_broadcasts (created_at DESC);

-- How many template messages leave per tick. Broadcasting faster than this is
-- how a new number's quality rating gets wrecked before anyone replies.
INSERT INTO app_settings (key, value) VALUES ('whatsapp_broadcast_per_tick', '5')
ON CONFLICT (key) DO NOTHING;
