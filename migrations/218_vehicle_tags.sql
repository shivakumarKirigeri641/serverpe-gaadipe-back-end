-- 218_vehicle_tags.sql — GAADIPE TAG (user, 2026-10-29: "communicate between 2 vehicle owners based on vehicle numbers").
--
-- An owner puts a QR tag on their vehicle. Anyone who scans it reaches the owner through GaadiPe with a preset reason
-- ("Your vehicle is blocking mine"); the owner replies in their own words; neither sees the other's number. Only owners
-- who CREATED a tag can be reached — never an owner looked up from any vehicle database. Built hidden: tag_enabled is
-- OFF, and only GaadiPe's own numbers (users.is_internal) can use it until the admin switches it on.
--
-- New tables only, plus one plan kind ('sticker', the paid delivered tag). Nothing existing changes behaviour.

CREATE TABLE IF NOT EXISTS vehicle_tags (
  id              bigserial PRIMARY KEY,
  -- What the QR carries: /t/<code>. 6 characters, no look-alikes (0/O, 1/I/L, 5/S).
  code            text        NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{6}$'),
  user_id         bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id      bigint      NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  is_active       boolean     NOT NULL DEFAULT true,
  scans           integer     NOT NULL DEFAULT 0,
  last_scan_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz
);
-- One live tag per vehicle per owner; an old one switched off can stay for the record.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_tags_live ON vehicle_tags (user_id, vehicle_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_vehicle_tags_user ON vehicle_tags (user_id);

-- One relayed message: a scanner's preset reason to the owner, and the owner's reply(ies) back.
CREATE TABLE IF NOT EXISTS tag_messages (
  id              bigserial PRIMARY KEY,
  tag_id          bigint      NOT NULL REFERENCES vehicle_tags(id) ON DELETE CASCADE,
  sender_mobile   text        NOT NULL CHECK (sender_mobile ~ '^[0-9]{10}$'),
  reason          text        NOT NULL,
  -- how the owner was told: whatsapp (free-form) / template / sms; or why not: blocked / limited / failed
  status          text        NOT NULL DEFAULT 'queued',
  channel         text,
  error           text,
  replies         integer     NOT NULL DEFAULT 0,
  last_reply      text,
  last_reply_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tag_messages_tag ON tag_messages (tag_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tag_messages_sender ON tag_messages (sender_mobile, created_at DESC);

-- An owner's "Block this person": that sender can never reach any of this owner's tags again.
CREATE TABLE IF NOT EXISTS tag_blocks (
  id              bigserial PRIMARY KEY,
  owner_user_id   bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_mobile   text        NOT NULL,
  message_id      bigint      REFERENCES tag_messages(id) ON DELETE SET NULL,
  reported        boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, sender_mobile)
);

-- A delivered sticker (paid, the 'sticker' plan). The address is kept only to post it.
CREATE TABLE IF NOT EXISTS tag_orders (
  id              bigserial PRIMARY KEY,
  tag_id          bigint      NOT NULL REFERENCES vehicle_tags(id) ON DELETE CASCADE,
  user_id         bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pincode         text        NOT NULL CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  zone            text        NOT NULL,
  amount_paise    integer     NOT NULL,
  ship_name       text,
  ship_address    text,
  payment_row_id  bigint      REFERENCES payments(id) ON DELETE SET NULL,
  status          text        NOT NULL DEFAULT 'created'
                  CHECK (status IN ('created', 'paid', 'dispatched', 'cancelled')),
  courier         text,
  tracking        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  dispatched_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_tag_orders_status ON tag_orders (status, created_at DESC);

-- The paid sticker is its own plan kind, so the hosted checkout, invoice and payment reports all work as for a pack.
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_kind_check;
ALTER TABLE plans ADD CONSTRAINT plans_kind_check CHECK (kind IN ('watch', 'report', 'fleet', 'replace', 'checks', 'sticker'));
-- Never listed for sale anywhere (inactive); the price comes from the zone (tag_zone_* settings) per order.
INSERT INTO plans (code, name, kind, price_paise, duration_days, is_active, sort_order, price_is_inclusive, monitoring)
SELECT 'TAG_STICKER', 'GaadiPe Tag sticker (delivered)', 'sticker', 5900, 0, false, 900, true, false
 WHERE NOT EXISTS (SELECT 1 FROM plans WHERE code = 'TAG_STICKER');

-- The switch and the numbers, all editable in admin Settings. OFF: only GaadiPe's own numbers can use tags.
INSERT INTO app_settings (key, value) VALUES
  ('tag_enabled', 'false'),
  ('tag_limit_per_vehicle_hour', '10'),        -- messages to one vehicle in an hour (start loose)
  ('tag_limit_per_sender_day', '30'),          -- messages one scanner can send in a day
  ('tag_zone_city', '59'),                     -- delivered sticker, ₹ incl. GST: same city as tag_pickup_pincode
  ('tag_zone_state', '69'),                    --   rest of the state
  ('tag_zone_india', '79'),                    --   rest of India
  ('tag_zone_remote', '119'),                  --   North-East, J&K, Ladakh, islands
  ('tag_pickup_pincode', '560013'),
  ('tag_alert_template', 'gp_tag_alert_v1'),   -- WhatsApp Utility template to the owner (outside the 24-hour window)
  ('tag_shipped_template', 'gp_tag_shipped_v1'),
  ('sms_tpl_tag_alert', ''),                   -- Fast2SMS message id of the approved DLT owner-alert SMS (empty: no SMS)
  ('sms_tpl_tag_shipped', '')
ON CONFLICT (key) DO NOTHING;
