-- 105_plan_discount.sql — a discount on a plan, in paise (user, 2026-10-03):
-- the customer pays the price less the discount, everywhere the price is shown
-- and charged (src/pay/billing.js). 0 = no discount.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS discount_paise integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE plans ADD CONSTRAINT plans_discount_ok CHECK (discount_paise >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
