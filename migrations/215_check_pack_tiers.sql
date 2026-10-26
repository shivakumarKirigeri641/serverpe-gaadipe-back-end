-- 215_check_pack_tiers.sql (user, 2026-10-26: "₹25 gives 5 checks, ₹50 gives 12, ₹100 gives 25 ... hide the fleet";
-- the recommendation taken: ₹49 and ₹99, longer validity for the bigger packs).
--
--   CHECKS5    ₹25   5 checks   30 days   (migration 213-214)
--   CHECKS12   ₹49  12 checks   60 days
--   CHECKS25   ₹99  25 checks   90 days   "best value"
--
-- plans.check_credits: how many checks a pack plan gives - editable in the admin's plan editor with the price,
-- the days, the discount and on/off. pay/packs.js reads every active 'checks' plan, cheapest first.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS check_credits int;
UPDATE plans SET check_credits = 5, name = 'Vehicle checks — 5 checks, valid 30 days' WHERE code = 'CHECKS5';

INSERT INTO plans (code, name, kind, price_paise, extra_vehicle_paise, gst_percent, duration_days, max_vehicles,
                   is_active, sort_order, price_is_inclusive, renewal_paise, trial_days, discount_paise, monitoring, check_credits)
SELECT v.code, v.name, 'checks', v.price, 0, gst_percent, v.days, 0, true, sort_order + v.ord, price_is_inclusive,
       NULL, 0, 0, false, v.credits
  FROM plans,
       (VALUES ('CHECKS12', 'Vehicle checks — 12 checks, valid 60 days', 4900, 60, 12, 1),
               ('CHECKS25', 'Vehicle checks — 25 checks, valid 90 days', 9900, 90, 25, 2)) AS v(code, name, price, days, credits, ord)
 WHERE plans.code = 'CHECKS5'
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, kind = 'checks', price_paise = EXCLUDED.price_paise, duration_days = EXCLUDED.duration_days,
  check_credits = EXCLUDED.check_credits, monitoring = false, is_active = true;

-- The Terms name all three (one sentence, same version: the price is shown before every payment, nothing renews).
UPDATE terms_and_conditions
   SET description = replace(description,
         'a pack of 5 checks costs Rs.25 inclusive of GST and is valid for 30 days',
         'packs of 5 checks for Rs.25 (valid 30 days), 12 checks for Rs.49 (valid 60 days) and 25 checks for Rs.99 '
         || '(valid 90 days) are available, each inclusive of GST; a vehicle already checked can be checked again free'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active
   AND description LIKE '%a pack of 5 checks costs Rs.25 inclusive of GST and is valid for 30 days%';
