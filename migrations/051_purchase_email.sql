-- 051_purchase_email.sql — the thank-you email after a purchase (user, 2026-09-22).
--
-- Until now a customer who paid heard back only on WhatsApp: receipt, report,
-- PDF, invoice. Someone who bought from the website and gave an email address
-- got nothing there. This adds the purchase email, queued like every other
-- customer email so it is retried, recorded and honours test mode.
--
-- payment_id is what makes it once-only: one purchase email per payment, so a
-- webhook retry or the reconciler recovering the same payment cannot mail twice.

ALTER TABLE customer_emails
  ADD COLUMN IF NOT EXISTS payment_id bigint REFERENCES payments(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_emails_purchase
    ON customer_emails (payment_id) WHERE kind = 'purchase';
