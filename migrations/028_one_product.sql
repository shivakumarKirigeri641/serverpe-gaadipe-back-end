-- 028_one_product.sql — one product, one price.
--
-- The plans table still carried the shapes GaadiPe tried before the Rs.19
-- report: a Rs.59 monthly watch, a Rs.799 annual one, and a zero-priced fleet
-- plan for up to five vehicles. None of them is sold, and none of them should
-- be: every extra plan is another price to explain on the website, another
-- branch in the bot, and another row in the panel that invites somebody to turn
-- it on by accident.
--
-- They are DELETED rather than deactivated because nothing references them —
-- no payment, no subscription — and a deactivated plan is still a plan
-- somebody has to read past. If one ever comes back it comes back as a
-- deliberate decision, not as a row that was left lying around.
--
-- The settings that priced them go too, for the same reason.

DELETE FROM plans
 WHERE code IN ('WATCH28', 'WATCH365', 'FLEET')
   AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.plan_id = plans.id)
   AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.plan_id = plans.id);

DELETE FROM app_settings WHERE key IN (
  'first_payment_paise',        -- the Rs.59 first payment
  'renewal_paise',              -- the Rs.39 renewal
  'extra_vehicle_paise'
);

-- One row left, and the panel's plan list now says so.
