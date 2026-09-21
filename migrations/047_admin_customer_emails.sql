-- 047_admin_customer_emails.sql — the admin writes to customers by email
-- (user, 2026-09-21), from the panel: one customer, or a group.
--
-- The same rules as every customer email (mail/customer.js): only CONFIRMED
-- addresses, never an unsubscribed one, the unsubscribe link in every email,
-- and TEST MODE (customer_email_only_to) holds everything back but the owner's
-- own address. Sent by the customer-mail job, a few a minute (Hostinger limits).

CREATE TABLE IF NOT EXISTS admin_email_campaigns (
  id            bigserial PRIMARY KEY,
  admin_id      bigint,
  audience      text        NOT NULL,        -- one | all | paying | not_paying | referrers
  target_mobile text,
  subject       text        NOT NULL,
  body          text        NOT NULL,
  status        text        NOT NULL DEFAULT 'queued',  -- queued | sent | cancelled
  recipients    integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

ALTER TABLE customer_emails ADD COLUMN IF NOT EXISTS campaign_id bigint REFERENCES admin_email_campaigns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_customer_emails_campaign ON customer_emails (campaign_id) WHERE campaign_id IS NOT NULL;

INSERT INTO app_settings (key, value) VALUES
  ('admin_customer_email_enabled', 'true')    -- the panel's "write to customers"
ON CONFLICT (key) DO NOTHING;

/* A NEW Email policy section for these; existing text is not changed. */
INSERT INTO email_policy (id, title, description, display_order, is_active, version, effective_from)
SELECT m.nid, 'Announcements from GaadiPe',
       'Occasionally GaadiPe may email you an announcement about the service itself — for example a change to how reports, alerts or prices work, a new feature, or an offer from GaadiPe or ServerPe App Solutions. These go only to a confirmed address, never more than a few times a month, and carry the same Unsubscribe link: unsubscribing stops them together with vehicle updates.',
       m.nord, true, '1.2', CURRENT_DATE
  FROM (SELECT coalesce(max(id), 0) + 1 AS nid, coalesce(max(display_order), 0) + 1 AS nord FROM email_policy) m
 WHERE NOT EXISTS (SELECT 1 FROM email_policy WHERE title = 'Announcements from GaadiPe');
