-- 006_partners.sql — the Refer & Earn programme
--
-- Not built yet, but modelled now because retrofitting commission onto live
-- payments is painful and error-prone.
--
-- THE MODEL: 10% of the customer's first payment, 5% of every renewal, for as
-- long as that customer keeps paying. Accrued per payment, paid monthly in one
-- UPI transfer, minimum ₹100 with the remainder carried forward.
--
-- WHY THE OLD `referrals` TABLE COULD NOT DO THIS: it modelled free days
-- between two users — referrer, referee, reward_days. It had nowhere to put a
-- partner who is not a customer (an insurance agent with no vehicle), no UPI
-- id, no per-payment earning, no payout batch, and no clawback. Commission is
-- an event stream, not a one-off flag.
--
-- SAFEGUARDS BUILT IN, not bolted on:
--   * commission exists only against a real payment — nobody can profit from
--     signups, which is what keeps the programme honest;
--   * one partner per customer, set once, so nobody can claim another's;
--   * a refund reverses the commission;
--   * single level only — there is deliberately no parent_partner_id, because
--     earning on people your recruits bring is what turns a referral scheme
--     into a chain scheme.

CREATE TABLE partners (
  id            bigserial PRIMARY KEY,
  -- A partner need not be a customer. An insurance agent may own no vehicle
  -- and never subscribe, so this is nullable rather than a users FK.
  user_id       bigint      REFERENCES users(id) ON DELETE SET NULL,
  name          text        NOT NULL,
  mobile        text        NOT NULL UNIQUE CHECK (mobile ~ '^[0-9]{10}$'),
  email         text,
  -- Shared publicly, so it avoids ambiguous characters (0/O, 1/I) — it gets
  -- read aloud, typed by hand and copied off screenshots.
  code          text        NOT NULL UNIQUE,
  -- 'individual' | 'insurance_agent' | 'rto_agent' | 'driving_school'
  -- | 'dealer' | 'garage' | 'other'
  kind          text        NOT NULL DEFAULT 'individual',
  upi_id        text,
  -- Needed only if annual earnings approach the TDS threshold; collected late,
  -- never at signup.
  pan           text,
  status        text        NOT NULL DEFAULT 'active'
                CHECK (status IN ('pending', 'active', 'suspended', 'closed')),
  suspended_reason text,
  -- Guardrail while the programme is new; null means uncapped.
  monthly_cap   integer,
  notes         text,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  modified_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_partners_code ON partners (code) WHERE status = 'active';

-- Who a partner brought. One row per customer, for life.
CREATE TABLE partner_referrals (
  id            bigserial PRIMARY KEY,
  partner_id    bigint      NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- UNIQUE: a customer belongs to exactly one partner, permanently. Without
  -- this, two partners could claim the same person and both be paid.
  user_id       bigint      NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code_used     text        NOT NULL,
  -- Nothing is earned until money arrives. A signup pays nothing, which is
  -- what makes the scheme unattackable.
  first_paid_at timestamptz,
  -- Self-referral: same mobile, or same device as the partner.
  is_blocked    boolean     NOT NULL DEFAULT false,
  blocked_reason text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_partner_referrals_partner ON partner_referrals (partner_id, created_at DESC);

-- One row PER PAYMENT — the important shift from the old design.
-- A customer paying every 28 days generates a commission row every 28 days.
CREATE TABLE partner_commissions (
  id            bigserial PRIMARY KEY,
  partner_id    bigint      NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  referral_id   bigint      NOT NULL REFERENCES partner_referrals(id) ON DELETE CASCADE,
  -- UNIQUE: a payment can only ever earn commission once, however many times
  -- a webhook is replayed.
  payment_id    bigint      NOT NULL UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
  kind          text        NOT NULL CHECK (kind IN ('first', 'renewal')),
  rate_percent  numeric(5,2) NOT NULL,        -- 10.00 first, 5.00 renewal
  -- The payment amount this was calculated from, kept so a partner asking
  -- "why is this ₹4?" can be answered from one row.
  base_paise    integer     NOT NULL,
  amount_paise  integer     NOT NULL,
  status        text        NOT NULL DEFAULT 'accrued'
                CHECK (status IN ('accrued', 'paid', 'clawed_back', 'cancelled')),
  payout_id     bigint,
  clawback_reason text,
  earned_at     timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz
);

CREATE INDEX idx_commissions_partner ON partner_commissions (partner_id, earned_at DESC);
CREATE INDEX idx_commissions_unpaid ON partner_commissions (partner_id) WHERE status = 'accrued';

-- The monthly batch. Paid on the 5th, in one UPI transfer.
--
-- Batched rather than instant on purpose: it gives a window to look at anything
-- odd before money leaves, and it makes rapid farming pointless.
CREATE TABLE partner_payouts (
  id              bigserial PRIMARY KEY,
  partner_id      bigint      NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  period          text        NOT NULL,       -- '2026-09'
  -- Earned this period, plus anything carried in from below the minimum.
  earned_paise    integer     NOT NULL,
  carried_in_paise integer    NOT NULL DEFAULT 0,
  total_paise     integer     NOT NULL,
  -- Below the ₹100 minimum the whole amount carries to next month rather than
  -- generating a transfer that costs more than it pays.
  carried_out_paise integer   NOT NULL DEFAULT 0,
  paid_paise      integer     NOT NULL DEFAULT 0,
  upi_id          text,
  upi_ref         text,
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'paid', 'carried', 'failed', 'on_hold')),
  hold_reason     text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  CONSTRAINT partner_payouts_period_unique UNIQUE (partner_id, period)
);

CREATE INDEX idx_payouts_period ON partner_payouts (period, status);

ALTER TABLE partner_commissions
  ADD CONSTRAINT partner_commissions_payout_fk
  FOREIGN KEY (payout_id) REFERENCES partner_payouts(id) ON DELETE SET NULL;

-- users.referred_by points at the partner who brought them.
ALTER TABLE users
  ADD CONSTRAINT users_referred_by_fk
  FOREIGN KEY (referred_by) REFERENCES partners(id) ON DELETE SET NULL;

INSERT INTO app_settings (key, value) VALUES
  ('partner_rate_first',    '10'),
  ('partner_rate_renewal',  '5'),
  ('partner_min_payout_paise', '10000'),
  ('partner_payout_day',    '5'),
  ('partner_programme_enabled', 'false');
