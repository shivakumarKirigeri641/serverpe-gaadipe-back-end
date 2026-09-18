-- 016_pricing_59_39.sql — Rs.59 first, Rs.39 renewal. Rs.10 / Rs.5 to partners.
--
-- Both prices are still all-inclusive: GST inside, gateway fee absorbed,
-- nothing added at checkout. Only the numbers move.
--
-- WHY Rs.59 AND NOT Rs.49: the renewal is the number that compounds. A customer
-- pays the first price once and the renewal twelve times a year, so Rs.29 ->
-- Rs.39 lifts the yearly net per vehicle from Rs.295 to Rs.377 and drops the
-- vehicles needed for Rs.1 lakh a cycle from ~4,635 to ~3,565. Rs.39 for 28 days
-- of watching is still far below a single Rs.500 challan.
--
-- A DETAIL WORTH KEEPING: Rs.59 inclusive is exactly Rs.50 taxable plus Rs.9
-- GST. A round taxable value makes every invoice and every GSTR-1 line reconcile
-- without fractions, which Rs.41.53 never did.
--
-- PARTNERS DOUBLE. Rs.10 on a vehicle's first payment and Rs.5 on every renewal
-- is ~20% and ~15% of the taxable value — high, but paid out of a larger number,
-- and distribution is the actual constraint on this business. Ten referred
-- customers now earn a partner Rs.700 in the first year instead of Rs.410, which
-- is the difference between pocket money and a reason to walk into a garage.
-- It is also easier to say: "Rs.10 per vehicle, then Rs.5 every renewal."
--
-- If conversion at Rs.59 disappoints, every number here is one UPDATE away —
-- and lowering a price is always easier than raising one.

BEGIN;

UPDATE plans SET
  name          = 'Watch — Rs.59 first, Rs.39 renewal',
  price_paise   = 5900,
  extra_vehicle_paise = 5900,
  renewal_paise = 3900
WHERE code = 'WATCH28';

INSERT INTO app_settings (key, value) VALUES
  ('first_payment_paise',                '5900'),
  ('renewal_paise',                      '3900'),
  ('partner_first_paise_per_vehicle',    '1000'),   -- Rs.10
  ('partner_renewal_paise_per_vehicle',   '500')    -- Rs.5
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- The published partner policy must never disagree with what is actually paid.
UPDATE partner_policy SET
  description = 'You earn Rs.10.00 per vehicle when a customer you introduced makes their '
    || 'first payment, and Rs.5.00 per vehicle on every renewal they pay after that, for '
    || 'as long as they keep renewing. A customer with three vehicles therefore earns you '
    || 'Rs.30.00 on their first payments and Rs.15.00 on every renewal. Nothing is earned '
    || 'during the free trial, because no payment has been made. There are no tiers, no '
    || 'bonuses and no targets.',
  modified_at = now()
WHERE id = 6;

UPDATE partner_policy SET
  description = 'Commission follows the vehicles actually paid for. If a customer '
    || 'subscribes for three vehicles, you earn for three, whatever number was discussed '
    || 'beforehand. If they add a vehicle later, that vehicle earns Rs.10.00 as its first '
    || 'payment and Rs.5.00 on every renewal after. If they stop paying for a vehicle, the '
    || 'commission for it stops. Nothing is earned for a vehicle nobody has paid for.',
  modified_at = now()
WHERE id = 9;

-- Same for the Terms: a price in a published document that is not the price
-- charged is the first thing produced in a dispute.
UPDATE terms_and_conditions SET
  description = 'Watch is a paid, per-vehicle monitoring plan. The first 28 days cost '
    || 'Rs.59 per vehicle and every renewal costs Rs.39 per vehicle. Both prices are '
    || 'inclusive of GST and of payment-gateway charges — the amount shown is the amount '
    || 'you pay, with nothing added at checkout. Each vehicle is billed and renewed '
    || 'separately, with its own 28-day term. You may monitor up to four vehicles per '
    || 'mobile number; for five or more, please write to support@gaadipe.in. There is NO '
    || 'auto-charge and NO auto-renewal: monitoring simply stops at the end of the term '
    || 'unless you choose to renew. A vehicle whose monitoring has lapsed and is restarted '
    || 'is charged at the first-payment price again.',
  version = '2.1', effective_from = CURRENT_DATE, modified_at = now()
WHERE id = 16;

COMMIT;
