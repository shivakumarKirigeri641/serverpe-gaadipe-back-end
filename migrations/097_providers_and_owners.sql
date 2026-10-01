-- 097_providers_and_owners.sql (user, 2026-10-01)
--
-- provider_status: the outside services GaadiPe depends on — VAHAN, eChallan,
--   FASTag, WhatsApp, Razorpay, email — as the real calls find them. Every live
--   call records its outcome (src/util/providerStatus.js); the admin panel's
--   status strip reads this. No extra calls are made to fill it.
--
-- vehicle_owner_claims: a customer proving they own a vehicle (src/owners/verify.js)
--   by typing the chassis number and the insurance policy (or engine) number
--   from their RC — parts of the Government record GaadiPe holds but never
--   shows. Behind the owner_verification flag, off until switched on.

CREATE TABLE IF NOT EXISTS provider_status (
  provider          text        PRIMARY KEY,         -- vahan | echallan | fastag | whatsapp | razorpay | email
  last_ok_at        timestamptz,
  last_fail_at      timestamptz,
  last_error        text,
  last_ms           integer,
  consecutive_fails integer     NOT NULL DEFAULT 0,
  recent            jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- newest first: [true, false, …], at most 20
  calls             bigint      NOT NULL DEFAULT 0,
  modified_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicle_owner_claims (
  id            bigserial   PRIMARY KEY,
  user_id       bigint      REFERENCES users(id) ON DELETE SET NULL,
  mobile        text        NOT NULL,
  vehicle_id    bigint      REFERENCES vehicles(id) ON DELETE SET NULL,
  reg_no        text        NOT NULL,
  status        text        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'verified', 'failed', 'locked', 'rejected', 'revoked')),
  method        text        NOT NULL DEFAULT 'rc_details',
  checks        jsonb       NOT NULL DEFAULT '{}'::jsonb,       -- which checks passed — never what was typed
  attempts      integer     NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  verified_at   timestamptz,
  reviewed_by   bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  modified_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_owner_claims_who ON vehicle_owner_claims (mobile, reg_no, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_owner_claims_one_verified
  ON vehicle_owner_claims (vehicle_id, mobile) WHERE status = 'verified';

INSERT INTO app_settings (key, value) VALUES
  ('owner_verification_max_attempts', '3'),
  ('owner_verification_lock_hours',   '24')
ON CONFLICT (key) DO NOTHING;
