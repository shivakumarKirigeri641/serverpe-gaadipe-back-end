-- 022_partner_tds_clause.sql — say what is actually true about TDS.
--
-- Clause 12 was written assuming GaadiPe must deduct tax at source on every
-- commission payment. It does not, and saying so in a published policy is a
-- promise to do something unnecessary — which is worse than saying nothing,
-- because a partner reads it, expects a TDS certificate, and does not get one.
--
-- Section 194H places the obligation to deduct on an individual or HUF only
-- where turnover in the PRECEDING financial year exceeded the tax-audit
-- threshold — Rs.1 crore for a business. ServerPe App Solutions is a
-- proprietorship well below that, so no deduction is required today.
--
-- The clause is rewritten to state the position honestly and conditionally: no
-- deduction now, deduction if and when the law requires it, and the partner's
-- own income remains their own responsibility either way. That last part does
-- not change with turnover and is the part partners most often assume away.
--
-- The practical consequence, and the reason this is worth a migration: PAN is
-- no longer collected at sign-up. It was only ever there to enable a deduction
-- that is not happening, and asking a garage owner for a PAN on the first
-- screen is friction bought for nothing. It is requested later, if earnings
-- approach the point where it matters.

BEGIN;

UPDATE partner_policy SET
  title = 'Tax on Your Commission',
  description =
    'Commission is income in your hands and must be declared in your own income-tax '
    || 'return. GaadiPe does not currently deduct tax at source on commission payments: '
    || 'under section 194H of the Income-tax Act, 1961, a proprietorship is required to '
    || 'deduct only once its turnover crosses the tax-audit threshold, which ServerPe App '
    || 'Solutions has not. If and when that changes, we will deduct at the rate then in '
    || 'force, ask you for a PAN beforehand, deposit the amount against it, and it will '
    || 'appear in your Form 26AS. We will tell you before the first such deduction. '
    || 'Whether or not tax is deducted, declaring this income remains your responsibility.',
  version = '1.1', effective_from = CURRENT_DATE, modified_at = now()
WHERE id = 12;

-- Sign-up asks for what a payout actually needs: a name and a UPI id.
UPDATE partner_policy SET
  description =
    'You must be at least 18 years of age, resident in India, and capable of entering into '
    || 'a legally binding contract under the Indian Contract Act, 1872. You must provide a '
    || 'valid mobile number and a UPI id or bank account in your own name. Payouts are made '
    || 'only to an account matching the partner''s own name. A PAN may be requested later if '
    || 'your earnings reach a level where tax deduction becomes applicable.',
  version = '1.1', effective_from = CURRENT_DATE, modified_at = now()
WHERE id = 2;

COMMIT;
