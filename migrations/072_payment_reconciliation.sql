-- 072_payment_reconciliation.sql — GaadiPe's payments against Razorpay's
-- (user, 2026-09-25, operations module phase 2).
--
-- A run compares, never changes: it reads our payments and Razorpay's for a
-- window and writes one item per payment with what it found. Settling a stuck
-- payment stays the job of src/jobs/reconcile.js; a person reviews anything
-- that does not match here.

CREATE TABLE IF NOT EXISTS recon_runs (
  id           bigserial   PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  admin_id     bigint      REFERENCES admin_users(id),     -- null: the daily run
  range_from   timestamptz NOT NULL,
  range_to     timestamptz NOT NULL,
  status       text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  summary      jsonb       NOT NULL DEFAULT '{}',
  error        text
);
CREATE INDEX IF NOT EXISTS recon_runs_started_idx ON recon_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS recon_items (
  id                  bigserial   PRIMARY KEY,
  run_id              bigint      NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
  payment_row_id      bigint      REFERENCES payments(id),  -- null: missing internally
  gateway_payment_id  text,
  order_id            text,
  result              text        NOT NULL CHECK (result IN ('matched', 'missing_from_gateway', 'missing_internally',
                        'amount_mismatch', 'status_mismatch', 'webhook_missing', 'refund_mismatch', 'requires_review', 'pending')),
  internal_amount     int,
  gateway_amount      int,
  internal_status     text,
  gateway_status      text,
  refund_status       text,
  webhook_seen        boolean,
  detail              jsonb       NOT NULL DEFAULT '{}',
  reviewed_at         timestamptz,
  reviewed_by         bigint      REFERENCES admin_users(id),
  review_note         text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recon_items_run_idx     ON recon_items (run_id, result);
CREATE INDEX IF NOT EXISTS recon_items_payment_idx ON recon_items (payment_row_id);

-- Failure analytics and abandoned payments read Razorpay's webhooks by payment row.
CREATE INDEX IF NOT EXISTS event_log_rzp_ref_idx ON event_log ((detail->>'reference_id')) WHERE kind = 'razorpay_webhook';
CREATE INDEX IF NOT EXISTS payments_status_created_idx ON payments (status, created_at);
