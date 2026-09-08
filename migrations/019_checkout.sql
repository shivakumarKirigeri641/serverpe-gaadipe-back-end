-- 019_checkout.sql — a hosted checkout page for each payment.
--
-- A payment link is one hop: WhatsApp -> Razorpay's page. It works, but the
-- customer comes back to nothing, because a link gives us no callback — we only
-- learn about the money when a webhook arrives, and a webhook can be late,
-- misrouted or lost. A test payment sat unacknowledged for seven minutes for
-- exactly that reason.
--
-- With our own page the sequence becomes:
--
--   WhatsApp -> /pay/<token> (order summary) -> Razorpay Checkout
--            -> success callback in the browser
--            -> our server verifies the signature and activates AT ONCE
--            -> back to WhatsApp, where the confirmation is already waiting
--
-- The token is what makes the page addressable without a login: unguessable,
-- single-purpose, and tied to one payment. It is not a session and grants
-- nothing except the right to pay that one amount.

BEGIN;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS checkout_token text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_checkout_token
    ON payments (checkout_token) WHERE checkout_token IS NOT NULL;

COMMENT ON COLUMN payments.checkout_token IS
  'Unguessable id for the hosted checkout page. One payment, one token, no login.';

COMMIT;
