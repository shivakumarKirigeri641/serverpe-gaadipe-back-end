-- 010_flat_pricing.sql — one price, one commission, no tiers.
--
-- 008 priced vehicles in three bands (Rs.49 / Rs.29 / Rs.25) and paid partners
-- two different rates (first payment / renewal). Every one of those boundaries
-- was something to argue about or game: is this a first payment or a renewal,
-- does this customer count as five vehicles, what happens when they drop one.
--
-- All of it is deleted here. What remains:
--
--   Customer:  Rs.49 per vehicle, per 28 days, plus GST. Daily monitoring.
--   Partner:   Rs.5 per vehicle, every time that customer pays.
--
-- There is no first-payment rate, no renewal rate, no volume discount, no
-- fleet threshold in the pricing, and no percentage anywhere. Both sentences
-- fit in a WhatsApp message and neither has a boundary condition, so there is
-- nothing left to construct a gimmick around: a vehicle is either paid for in
-- a given cycle or it is not.
--
-- The cost of dropping the volume discount is that a four-vehicle customer now
-- pays Rs.196 instead of Rs.136. That is the price of a rule anyone can repeat
-- from memory, and it is honest — four vehicles genuinely cost four times as
-- much to monitor as one.

BEGIN;

-- Self-serve stops at four vehicles. Five or more is a conversation with
-- support@gaadipe.in: those customers want a quote, consolidated invoicing and
-- often a call, and none of that belongs in a WhatsApp payment link.
UPDATE plans SET name = 'Fleet — 5+ vehicles, quoted', max_vehicles = NULL
WHERE code = 'FLEET';

/* ------------------------------------------------------------------ plans */

-- One rate per vehicle: the "extra vehicle" and bulk bands become the same
-- price as the first, which is what makes the whole tier system disappear
-- rather than merely being set to equal values by hand.
UPDATE plans SET
  name                = 'Watch — Rs.49 per vehicle, 28 days',
  price_paise         = 4900,
  extra_vehicle_paise = 4900,
  bulk_vehicle_paise  = NULL,
  bulk_from_vehicle   = NULL,
  max_vehicles        = 4,
  price_is_inclusive  = false,
  duration_days       = 28
WHERE code = 'WATCH28';

COMMENT ON COLUMN plans.extra_vehicle_paise IS
  'Per additional vehicle. Equal to price_paise under flat pricing — kept so a
   future plan can differ without a schema change.';

/* ------------------------------------------------------- partner earnings */

-- One amount, paid on every payment. No 'first' vs 'renewal' distinction in
-- the money; partner_commissions.kind still records which it was, because that
-- is useful to report on even when it does not change the amount.
INSERT INTO app_settings (key, value) VALUES
  ('partner_paise_per_vehicle', '500')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

DELETE FROM app_settings
 WHERE key IN ('partner_first_paise_per_vehicle', 'partner_renewal_paise_per_vehicle');

/* -------------------------------------------------------------- the words */

UPDATE partner_policy SET
  title = 'Commission',
  description = 'You earn Rs.5.00 per vehicle, every time a customer you introduced pays. '
    || 'It does not matter whether it is their first payment or their fortieth renewal, '
    || 'and it does not matter how many vehicles they have: one vehicle earns Rs.5.00 a '
    || 'cycle, four vehicles earn Rs.20.00 a cycle, for as long as they keep paying. '
    || 'Commission is calculated on the vehicles actually paid for in that cycle, '
    || 'excluding GST. There are no tiers, no bonuses and no targets.',
  modified_at = now()
WHERE id = 6;

UPDATE partner_policy SET
  title = 'What a Referral Is Worth at Each Payment',
  description = 'Commission follows the vehicles actually paid for in that cycle. If a '
    || 'customer subscribes for three vehicles, you earn Rs.15.00, whatever number was '
    || 'discussed beforehand. If they add a vehicle later, you earn Rs.20.00 a cycle from '
    || 'then on. If they drop one, you earn Rs.10.00. Nothing is earned for a vehicle '
    || 'nobody has paid for.',
  modified_at = now()
WHERE id = 9;

UPDATE partner_policy SET
  description = 'GaadiPe may revise the commission amount, and will publish the revised '
    || 'amount on this page before it takes effect. Commission already earned is honoured '
    || 'at the amount that applied when it was earned. Continuing to introduce customers '
    || 'after a change constitutes acceptance of the revised amount.',
  modified_at = now()
WHERE id = 7;

COMMIT;
