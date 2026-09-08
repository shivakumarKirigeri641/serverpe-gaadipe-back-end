-- 008_pricing_and_partner_terms.sql — the price people actually pay, and what
-- a partner actually earns.
--
-- Three decisions are recorded here, all of them reversals of what 004 and 006
-- assumed, and all of them made from live evidence rather than a spreadsheet:
--
--   1. ₹79 per 28 days did not sell. The price is now ₹49 and GST is charged on
--      top rather than carved out of it.
--
--   2. Commission is per VEHICLE, not a percentage of the invoice. Under the
--      old rule the multi-vehicle discount came out of the partner's pocket:
--      vehicle 1 earned 10% of ₹49 while vehicle 4 earned 10% of ₹29, so the
--      partner was paid least for the customers worth most. ₹5 per vehicle now,
--      ₹2.50 per vehicle on every renewal, whether that is one vehicle or
--      twenty — and it fits in one sentence a partner can repeat from memory.
--
--   3. Five vehicles no longer means "email us for a quote". A driving school
--      with five vehicles is worth ~₹2,100 a year and churns far less than a
--      single-car owner; making them wait for a reply is how that customer is
--      lost at the moment they were ready to pay. Self-serve now runs to 20.
--
-- The yearly plan is deliberately NOT priced here. It will be based on customer
-- count and is deferred; WATCH365 is deactivated rather than deleted so its
-- code and any history survive.

BEGIN;

/* ------------------------------------------------------------------ plans */

-- A third price band: ₹49 first, ₹29 for vehicles 2-4, ₹25 from the fifth. A
-- visible volume break rewards adding vehicles instead of capping them.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS bulk_vehicle_paise integer;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS bulk_from_vehicle  integer;

-- 004 assumed prices were GST-inclusive. They are not: the customer is shown
-- ₹49 and charged ₹49 + 18%. Recorded explicitly so an invoice can never guess
-- wrong about which it is.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_is_inclusive boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN plans.price_paise IS
  'First vehicle. Taxable value when price_is_inclusive is false — GST is added on top.';
COMMENT ON COLUMN plans.bulk_vehicle_paise IS
  'Per-vehicle price from bulk_from_vehicle onward. NULL means extra_vehicle_paise applies throughout.';

UPDATE plans SET
  name                = 'Watch — 28 days',
  price_paise         = 4900,     -- ₹49  first vehicle
  extra_vehicle_paise = 2900,     -- ₹29  vehicles 2-4
  bulk_vehicle_paise  = 2500,     -- ₹25  vehicle 5 onward
  bulk_from_vehicle   = 5,
  max_vehicles        = 20,       -- was 4; above this it is a real fleet sale
  price_is_inclusive  = false,
  is_active           = true
WHERE code = 'WATCH28';

-- Parked, not deleted. Pricing will follow customer count, decided later.
UPDATE plans SET is_active = false WHERE code = 'WATCH365';

-- 21+ vehicles: consolidated invoicing, exports, a negotiated rate — a
-- conversation worth having, unlike a ₹161 subscription.
UPDATE plans SET name = 'Fleet — 21+ vehicles, quoted', max_vehicles = NULL
WHERE code = 'FLEET';

/* ------------------------------------------------------- partner earnings */

-- Commission is now a flat amount per vehicle. rate_percent stays for the rows
-- already explained to partners under the old rule, but nothing new sets it.
ALTER TABLE partner_commissions ALTER COLUMN rate_percent DROP NOT NULL;
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS vehicle_count     integer;
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS per_vehicle_paise integer;

COMMENT ON COLUMN partner_commissions.rate_percent IS
  'Legacy percentage rule. NULL for anything earned under the per-vehicle rule.';
COMMENT ON COLUMN partner_commissions.vehicle_count IS
  'Vehicles on the subscription when this was earned — amount_paise = vehicle_count * per_vehicle_paise.';

INSERT INTO app_settings (key, value) VALUES
  ('partner_first_paise_per_vehicle',   '500'),   -- ₹5.00 on a vehicle's first payment
  ('partner_renewal_paise_per_vehicle', '250'),   -- ₹2.50 every renewal, per vehicle
  -- At ₹2.50 per vehicle per cycle, ₹100 took a one-vehicle referrer 41 months.
  ('partner_min_payout_paise',          '5000'),
  -- Whatever is outstanding is paid once a year regardless of the minimum, so
  -- nobody's earnings are stuck below a threshold forever.
  ('partner_annual_sweep_month',        '4')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- The percentage rule is gone, and leaving its settings behind would let a
-- future reader implement the wrong one.
DELETE FROM app_settings WHERE key IN ('partner_rate_first', 'partner_rate_renewal');

COMMIT;
