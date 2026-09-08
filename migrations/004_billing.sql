-- 004_billing.sql — plans, money, and statutory invoices
--
-- PAISE THROUGHOUT. Rupees as floats is how money quietly goes missing.
--
-- Pricing is ₹79 for the first vehicle and ₹40 for each one after, per 28 days,
-- or ₹799 + ₹400 yearly — all INCLUSIVE of GST, so the base is derived from the
-- collected amount rather than added to it. Fleets of five or more are quoted
-- individually, which is why a subscription carries its own price rather than
-- inheriting the plan's.

CREATE TABLE plans (
  id              bigserial PRIMARY KEY,
  code            text        NOT NULL UNIQUE,
  name            text        NOT NULL,
  -- 'watch'  recurring monitoring
  -- 'report' one-off (kept for a future buyer report)
  -- 'fleet'  negotiated, price lives on the subscription
  kind            text        NOT NULL CHECK (kind IN ('watch', 'report', 'fleet')),
  -- What the customer pays, GST included.
  price_paise     integer     NOT NULL,
  -- Each additional vehicle on the same plan.
  extra_vehicle_paise integer NOT NULL DEFAULT 0,
  gst_percent     numeric(5,2) NOT NULL DEFAULT 18.00,
  duration_days   integer     NOT NULL DEFAULT 28,
  max_vehicles    integer,                    -- null = unlimited (fleet)
  is_active       boolean     NOT NULL DEFAULT true,
  sort_order      integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id            bigserial PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id       bigint      NOT NULL REFERENCES plans(id),
  vehicle_count integer     NOT NULL DEFAULT 1,
  -- Frozen at purchase. A later price change must never alter what an existing
  -- customer is charged on renewal without them agreeing to it.
  price_paise   integer     NOT NULL,
  starts_on     date        NOT NULL DEFAULT CURRENT_DATE,
  ends_on       date        NOT NULL,
  is_active     boolean     NOT NULL DEFAULT true,
  -- How many times this customer has renewed. Drives the partner commission
  -- rate: 10% on the first payment, 5% on every one after.
  renewal_count integer     NOT NULL DEFAULT 0,
  cancelled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  modified_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_subs_user ON subscriptions (user_id, ends_on DESC);
CREATE INDEX idx_subs_expiring ON subscriptions (ends_on) WHERE is_active;

CREATE TABLE payments (
  id             bigserial PRIMARY KEY,
  user_id        bigint      REFERENCES users(id) ON DELETE SET NULL,
  subscription_id bigint     REFERENCES subscriptions(id) ON DELETE SET NULL,
  plan_id        bigint      REFERENCES plans(id),
  amount_paise   integer     NOT NULL,
  status         text        NOT NULL DEFAULT 'created'
                 CHECK (status IN ('created', 'paid', 'failed', 'refunded')),
  gateway        text        NOT NULL DEFAULT 'razorpay',
  order_id       text,
  -- Unique so a webhook replay cannot double-credit a subscription, which is
  -- the classic way a gateway integration goes wrong.
  payment_id     text UNIQUE,
  refund_id      text,
  raw            jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz,
  refunded_at    timestamptz
);

CREATE INDEX idx_payments_user ON payments (user_id, created_at DESC);
CREATE INDEX idx_payments_order ON payments (order_id) WHERE order_id IS NOT NULL;

-- Invoice numbers must be sequential, gap-free and never reused. A counter row
-- locked per financial year is the only safe way to allocate them concurrently.
CREATE TABLE document_counters (
  key         text PRIMARY KEY,               -- e.g. 'invoice:2026-27'
  next_value  integer NOT NULL DEFAULT 1,
  modified_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id              bigserial PRIMARY KEY,
  user_id         bigint      NOT NULL REFERENCES users(id),
  subscription_id bigint      REFERENCES subscriptions(id) ON DELETE SET NULL,
  payment_id      bigint      REFERENCES payments(id) ON DELETE SET NULL,
  -- Statutory: sequential, never reused, never deleted.
  invoice_number  text        NOT NULL UNIQUE,
  invoice_date    date        NOT NULL DEFAULT CURRENT_DATE,
  -- Prices are GST-inclusive, so base is derived: total / (1 + gst/100).
  base_paise      integer     NOT NULL,
  gst_percent     numeric(5,2) NOT NULL DEFAULT 18.00,
  cgst_paise      integer     NOT NULL DEFAULT 0,
  sgst_paise      integer     NOT NULL DEFAULT 0,
  igst_paise      integer     NOT NULL DEFAULT 0,
  total_paise     integer     NOT NULL,
  -- Decides CGST+SGST (same state) versus IGST (different state).
  place_of_supply text,
  buyer_name      text,
  buyer_gstin     text,
  pdf_path        text,
  -- Unguessable token so an invoice can be opened from WhatsApp without a login.
  access_token    text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_user ON invoices (user_id, invoice_date DESC);

CREATE TABLE gst_percentages (
  id          bigserial PRIMARY KEY,
  percent     numeric(5,2) NOT NULL,
  -- Rates change by notification; an old invoice must keep the rate that
  -- applied on its date, so this is a history rather than a single value.
  effective_from date      NOT NULL,
  effective_to   date,
  is_active   boolean     NOT NULL DEFAULT true
);

INSERT INTO gst_percentages (percent, effective_from) VALUES (18.00, '2017-07-01');

INSERT INTO plans (code, name, kind, price_paise, extra_vehicle_paise, duration_days, max_vehicles, sort_order) VALUES
  ('WATCH28',  'Watch — 28 days', 'watch',  7900,  4000,  28, 4, 1),
  ('WATCH365', 'Watch — 1 year',  'watch', 79900, 40000, 365, 4, 2),
  ('FLEET',    'Fleet — quoted',  'fleet',     0,     0,  28, NULL, 3);
