-- 055_monitoring_28_days.sql — 28 days, then renew (user, 2026-09-23).
--
-- WHAT CHANGED FROM 054, AND WHY. That migration gave ₹19 ninety days of
-- challan watching and expiry warnings with no end date. The reasoning was
-- sound — PUC is six-monthly, so a short window catches few of them — but it
-- left nothing to sell twice: a customer who is warned for ever has no reason
-- to pay again.
--
-- So: 28 days, and then it stops. Both halves stop — challans AND expiry
-- warnings — because a warning that keeps arriving free is the renewal nobody
-- buys. On day 25 they are told it is ending, and renewing the same vehicle
-- costs ₹9 + GST instead of ₹19.
--
-- WHY THE RENEWAL IS CHEAPER, honestly: it buys 28 more days of the same
-- watching, but issues no new report, no new PDF and no new lookup for one —
-- about 19 upstream calls against 22. The customer pays roughly half for
-- roughly seven-eighths of the cost, which is a real discount, not a trick.
--
-- Nothing is removed here. plans.renewal_paise already existed and priceFor()
-- already knew that "first payment" is a property of the VEHICLE, not the
-- customer — this fills them in for the report plan.

/* ─────────────────────────── 1. back to 28 days ─────────────────────────── */

UPDATE plans
   SET duration_days = 28,
       renewal_paise = 1062,          -- ₹9 + 18% GST, the same figure the
                                      -- referral reduced-price path uses
       name = 'Full report — Rs.19 (PDF, 28-day monitoring)'
 WHERE code = 'REPORT19';

/* The nudge goes out this many days before monitoring ends. */
INSERT INTO app_settings (key, value) VALUES ('renewal_notice_days', '3')
ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('renewal_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

/*
 * Expiry warnings now stop with the subscription.
 *
 * 054 set expiry_warning_months to 18, meaning "keep warning long after they
 * paid". That is what made the renewal worthless, so it goes to 0: warn only
 * while monitoring is actually running. The setting stays rather than being
 * dropped — it is how this decision gets reversed if renewals do not sell.
 */
UPDATE app_settings SET value = '0' WHERE key = 'expiry_warning_months';

/* ──────────────────────── 2. support tickets ──────────────────────── */

/*
 * A ticket number, because "I wrote to you last week" needs something to point
 * at. Numbered from document_counters, the same mechanism as reports and
 * invoices, so numbering is gapless and cannot collide under load.
 */
ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS ticket_no    text;
ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS replied_at   timestamptz;
ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS reply_text   text;
ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS replied_by   bigint;
ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS channel      text;
-- The one-time link that opens the support form already knowing who they are.
ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS support_token text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_ticket ON contact_messages (ticket_no)
    WHERE ticket_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_open ON contact_messages (created_at DESC)
    WHERE replied_at IS NULL;

/*
 * The token that lets someone open the support form from a WhatsApp message
 * without signing in. Short-lived, single purpose, and it identifies nobody by
 * itself — it is looked up, not decoded.
 */
CREATE TABLE IF NOT EXISTS support_tokens (
  token      text        PRIMARY KEY,
  user_id    bigint      REFERENCES users(id) ON DELETE CASCADE,
  mobile     text        NOT NULL,
  reg_no     text,
  used_at    timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_tokens_live ON support_tokens (expires_at)
    WHERE used_at IS NULL;

/* How long that link works. Long enough to finish typing, short enough to matter. */
INSERT INTO app_settings (key, value) VALUES ('support_link_hours', '48')
ON CONFLICT (key) DO NOTHING;

/* ──────────────────────── 3. the template names ──────────────────────── */

/*
 * Named here so the code never carries a template name as a literal. Raising a
 * v2 in Meta is then a settings change, not a deploy — which matters, because
 * a rejected template has to be replaced while people are waiting on it.
 */
INSERT INTO app_settings (key, value) VALUES ('wa_template_monitoring', 'gp_monitoring_alert_en_v1')
ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('wa_template_renewal', 'gp_renewal_en_v1')
ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('wa_template_support_reply', 'gp_support_reply_en_v1')
ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('wa_template_language', 'en')
ON CONFLICT (key) DO NOTHING;
