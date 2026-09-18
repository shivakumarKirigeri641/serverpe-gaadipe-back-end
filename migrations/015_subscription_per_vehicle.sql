-- 015_subscription_per_vehicle.sql — one subscription per vehicle.
--
-- 004 modelled a subscription as belonging to a customer, with a vehicle_count
-- beside it. That is wrong for this product, and wrong in a way that gives
-- service away:
--
--   day 0   pay Rs.49 for KA31N8147   -> subscription ends day 28
--   day 10  pay Rs.49 for KA02EX1480  -> the SAME subscription is extended,
--                                        so KA31N8147 silently gains 28 days
--
-- Every extra vehicle would hand the earlier ones a free month, compounding
-- with each purchase.
--
-- The price has always been described per vehicle — Rs.49 for a vehicle's first
-- 28 days, Rs.29 for each renewal of that vehicle — so the subscription should
-- be per vehicle too. Each has its own clock, its own renewal, its own
-- reminder. vehicle_count stops being arithmetic anyone has to do.
--
-- The cost is that renewal reminders arrive on different days for someone who
-- bought on different days. That is honest, and it keeps every payment a single
-- small number, which is the whole reason Rs.49 sells where Rs.79 did not. A
-- "renew all" link that bundles several is an optimisation for later, not the
-- model.

BEGIN;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS vehicle_id bigint
  REFERENCES vehicles(id) ON DELETE CASCADE;

COMMENT ON COLUMN subscriptions.vehicle_id IS
  'The one vehicle this subscription covers. Each vehicle is bought, renewed and
   reminded about independently.';

COMMENT ON COLUMN subscriptions.vehicle_count IS
  'Legacy from the per-customer model. Always 1 under per-vehicle subscriptions.';

-- One live subscription per vehicle per customer. A second purchase for the
-- same vehicle must extend the existing row, never create a parallel one that
-- would be renewed and reminded about twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_active_vehicle
    ON subscriptions (user_id, vehicle_id)
 WHERE is_active AND vehicle_id IS NOT NULL;

-- Finding what is due for renewal is the most frequent question asked of this
-- table, and it is asked about vehicles that are still running.
CREATE INDEX IF NOT EXISTS idx_subscriptions_ending
    ON subscriptions (ends_on) WHERE is_active;

COMMIT;
