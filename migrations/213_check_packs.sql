-- 213_check_packs.sql (user, 2026-10-26: "1 customer, 1 vehicle check free, multiple checks not allowed ... it is
-- becoming a loss for me" - 43 paid RC lookups, ₹100, against ₹22 of sales in a day).
--
-- ONE FREE CHECK, THEN A PACK. Every customer's first vehicle check is free. After that each new check uses a
-- credit: CHECKS5, ₹20 including GST, gives 5 checks valid 30 days; every full report bought (₹11 or ₹19) adds 5
-- too. Repeats of the same vehicle within checks_repeat_window_minutes, and a vehicle they hold a valid report for,
-- never use one. util/quota.js counts; pay/billing.js adds credits; check_packs_enabled = false goes back to the
-- old daily / monthly allowance.

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_kind_check;
ALTER TABLE plans ADD CONSTRAINT plans_kind_check CHECK (kind IN ('watch', 'report', 'fleet', 'replace', 'checks'));

-- Copied from REPORT19 so the GST rate and inclusive pricing match. duration_days = how long the checks last.
INSERT INTO plans (code, name, kind, price_paise, extra_vehicle_paise, gst_percent, duration_days, max_vehicles,
                   is_active, sort_order, price_is_inclusive, renewal_paise, trial_days, discount_paise, monitoring)
SELECT 'CHECKS5', 'Vehicle checks — 5 checks, valid 30 days', 'checks', 2000, 0, gst_percent, 30, 0,
       true, sort_order + 2, price_is_inclusive, NULL, 0, 0, false
  FROM plans WHERE code = 'REPORT19'
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, kind = 'checks', price_paise = 2000, duration_days = 30, renewal_paise = NULL,
  monitoring = false, is_active = true;

-- One row per grant: a pack, or the bonus with a report. Used up oldest-expiring first (quota.consume).
CREATE TABLE IF NOT EXISTS check_credits (
  id          bigserial   PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users(id),
  payment_id  bigint      REFERENCES payments(id),
  source      text        NOT NULL CHECK (source IN ('pack', 'report', 'admin')),
  credits     int         NOT NULL CHECK (credits > 0),
  used        int         NOT NULL DEFAULT 0 CHECK (used >= 0),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (used <= credits)
);
CREATE INDEX IF NOT EXISTS check_credits_user_idx ON check_credits (user_id, expires_at);
-- A payment grants once, however many times its webhook arrives.
CREATE UNIQUE INDEX IF NOT EXISTS check_credits_payment_uq ON check_credits (payment_id) WHERE payment_id IS NOT NULL;

INSERT INTO app_settings (key, value) VALUES
  ('check_packs_enabled', 'true'),
  ('free_checks_lifetime', '1'),
  ('check_credit_days', '30')
ON CONFLICT (key) DO NOTHING;

-- The Terms name the pack (one sentence, same version: the price is shown before every payment and nothing renews).
UPDATE terms_and_conditions
   SET description = description || ' Your first vehicle check is free. Further checks use check credits: a pack of '
         || '5 checks costs Rs.20 inclusive of GST and is valid for 30 days, and every full report bought adds 5 checks '
         || 'for 30 days. Unused checks expire and are not refunded.',
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active
   AND description NOT LIKE '%check credits%';
