-- 023_payout_threshold.sql — the payout floor drops to Rs.30.
--
-- Rs.50 was three first payments away for a partner just starting out, and the
-- first payout is the one that decides whether they keep sharing the link. A
-- partner who earns Rs.30 in their first month and is paid it believes the
-- programme is real; one who is told to wait another month often stops.
--
-- The floor costs nothing to lower: UPI transfers are free, and the only thing
-- it protects is the time spent approving payouts by hand. Rs.30 is reachable
-- in a first month — three first payments, or six renewals — which is exactly
-- where it should sit while the programme is being proven.
--
-- It goes lower still, or away entirely, once payouts are automated.

BEGIN;

UPDATE app_settings SET value = '3000' WHERE key = 'partner_min_payout_paise';

UPDATE partner_policy SET
  description =
    'Payouts are made monthly, on or about the 5th of each month, for commission earned up '
    || 'to the end of the previous month, provided your balance is at least Rs.30.00. Any '
    || 'balance below that carries forward and is added to the next payout — nothing is '
    || 'lost. Whatever remains outstanding is paid once a year in April regardless of the '
    || 'threshold, so earnings are never held indefinitely. Payouts are made by UPI or bank '
    || 'transfer to the details in your partner account; you are responsible for keeping '
    || 'them correct.',
  version = '1.1', effective_from = CURRENT_DATE, modified_at = now()
WHERE id = 11;

COMMIT;
