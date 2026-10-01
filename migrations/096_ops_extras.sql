-- 096_ops_extras.sql — admin additions (user, 2026-10-01):
--   lookup_waitlist   numbers sent while the vehicle records service was down;
--                     each person is sent their check automatically once it is back
--   ad_spend          what was spent on ads per day, for cost per customer
--   settings          the WhatsApp messaging limit, and the daily summary sent
--                     to the admin's own WhatsApp

CREATE TABLE IF NOT EXISTS lookup_waitlist (
  id            bigserial   PRIMARY KEY,
  mobile        text        NOT NULL,
  reg_no        text        NOT NULL,
  user_id       bigint      REFERENCES users(id) ON DELETE SET NULL,
  status        text        NOT NULL DEFAULT 'waiting'
                CHECK (status IN ('waiting', 'delivered', 'expired', 'failed')),
  attempts      integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz,
  note          text
);
CREATE UNIQUE INDEX IF NOT EXISTS lookup_waitlist_one_waiting
  ON lookup_waitlist (mobile, reg_no) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS lookup_waitlist_waiting ON lookup_waitlist (created_at) WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS ad_spend (
  id            bigserial   PRIMARY KEY,
  day           date        NOT NULL,
  product       text        NOT NULL DEFAULT 'gaadipe' CHECK (product IN ('gaadipe', 'quizpe')),
  channel       text        NOT NULL DEFAULT 'meta',
  amount_paise  integer     NOT NULL CHECK (amount_paise >= 0),
  note          text,
  created_by    bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  modified_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day, product, channel)
);

INSERT INTO app_settings (key, value) VALUES
  ('whatsapp_messaging_limit',        '250'),
  ('lookup_waitlist_enabled',         'true'),
  ('admin_whatsapp_numbers',          ''),
  ('admin_whatsapp_summary_hour_ist', '21')
ON CONFLICT (key) DO NOTHING;
