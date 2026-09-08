-- 011_final_pricing.sql — the pricing GaadiPe actually launches with.
--
--   Free trial   7 days, full monitoring, one per mobile
--   First 28 d   Rs.49  all inclusive
--   Renewal      Rs.29  all inclusive, every 28 days
--   Partner      Rs.5 on the first payment, Rs.3 on every renewal, per vehicle
--
-- "All inclusive" is load-bearing. GST is inside the Rs.49, the payment-gateway
-- fee comes out of our margin, and nothing is added at checkout. Rs.79 did not
-- sell, and a price that grows between the advert and the payment screen is the
-- same objection arriving later.
--
-- WHY THE RENEWAL IS CHEAPER THAN THE FIRST PAYMENT, which is backwards from
-- most subscriptions: the first cycle carries the work — the full report, the
-- first proper look at the vehicle. Staying should cost less than starting.
-- It also cannot be gamed: anyone who lapses and returns pays Rs.49 again.
--
-- Alternatives measured and rejected:
--   * Rs.40 + GST + 2.5% platform fee. Nets Rs.36.00 against Rs.36.53 here, so
--     it earns nothing on the first payment and 19% less on renewals, in
--     exchange for three lines at checkout and a fee charged on UPI where we
--     pay no MDR at all.
--   * Rs.25 renewal. Nets Rs.18.19, which pushes Rs.1 lakh per cycle from
--     ~4,635 vehicles to ~5,500. Held in reserve: if churn data later shows
--     price is why people stop, this is a one-row update.
--
-- Per vehicle, after GST, gateway and partner commission, we keep Rs.36.53 on
-- the first payment and Rs.21.58 on every renewal — a ~72% margin on both.

BEGIN;

/* ------------------------------------------------------------------ plans */

-- price_paise is now the total the customer pays, GST included.
UPDATE plans SET
  name                = 'Watch — Rs.49 first, Rs.29 renewal',
  price_paise         = 4900,
  extra_vehicle_paise = 4900,
  bulk_vehicle_paise  = NULL,
  bulk_from_vehicle   = NULL,
  max_vehicles        = 4,
  price_is_inclusive  = true,
  duration_days       = 28,
  is_active           = true
WHERE code = 'WATCH28';

-- The renewal price is a property of the plan, not a separate plan: the same
-- subscription simply costs less to continue than to start.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS renewal_paise integer;
COMMENT ON COLUMN plans.renewal_paise IS
  'What each subsequent 28-day cycle costs, GST included. NULL means renewals
   cost the same as the first payment.';

UPDATE plans SET renewal_paise = 2900 WHERE code = 'WATCH28';

-- Seven days, full monitoring, one per mobile. Recorded on the plan so the bot
-- has one place to read it from.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS trial_days integer NOT NULL DEFAULT 0;
UPDATE plans SET trial_days = 7 WHERE code = 'WATCH28';

/* ------------------------------------------------------- partner earnings */

INSERT INTO app_settings (key, value) VALUES
  ('partner_first_paise_per_vehicle',   '500'),   -- Rs.5 on the first payment
  ('partner_renewal_paise_per_vehicle', '300')    -- Rs.3 on every renewal
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 010 collapsed both into one amount. The renewal price is now lower than the
-- first payment, so the commission follows it down and the single-amount
-- setting no longer describes anything.
DELETE FROM app_settings WHERE key = 'partner_paise_per_vehicle';

/* -------------------------------------------------------- what we show */

-- Owner name, engine number and chassis number are never displayed, in any
-- product, on any screen. Two reasons, and the second is the one that matters
-- later: we cannot verify who owns a vehicle, so showing the owner's name to
-- whoever typed the plate is not defensible; and a chassis number that has
-- never been displayed remains something only the real owner knows, which is
-- what makes it usable as a verification challenge in future.
--
-- FASTag toll crossings are withheld for the same reason in a stronger form: a
-- crossing history is a movement log. Balance and tag status carry the useful
-- signal without turning a Rs.29 subscription into a tracking device.
INSERT INTO app_settings (key, value) VALUES
  ('hide_owner_name',        'true'),
  ('hide_chassis_engine',    'true'),
  ('hide_fastag_crossings',  'true'),
  ('hide_challan_location',  'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

/* -------------------------------------------------------------- the words */

-- 010 wrote a single flat amount into these clauses. The renewal is now Rs.3,
-- so the policy has to say so — a partner policy that disagrees with the payout
-- is worse than none at all.
UPDATE partner_policy SET
  description = 'You earn Rs.5.00 per vehicle when a customer you introduced makes their '
    || 'first payment, and Rs.3.00 per vehicle on every renewal they pay after that, for '
    || 'as long as they keep renewing. A customer with three vehicles therefore earns you '
    || 'Rs.15.00 on their first payment and Rs.9.00 every 28 days thereafter. Nothing is '
    || 'earned during the free trial, because no payment has been made. There are no '
    || 'tiers, no bonuses and no targets.',
  modified_at = now()
WHERE id = 6;

UPDATE partner_policy SET
  description = 'Commission follows the vehicles actually paid for in that cycle. If a '
    || 'customer subscribes for three vehicles, you earn for three, whatever number was '
    || 'discussed beforehand. If they add a vehicle later, that vehicle earns Rs.5.00 as '
    || 'its first payment and Rs.3.00 on every renewal after. If they drop a vehicle, the '
    || 'commission follows the smaller number. Nothing is earned for a vehicle nobody has '
    || 'paid for.',
  modified_at = now()
WHERE id = 9;

COMMIT;
