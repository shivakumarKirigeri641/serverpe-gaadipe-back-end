-- 012_terms_refresh.sql — bring the published Terms in line with the product.
--
-- The live Terms still describe the previous GaadiPe: Premium at Rs.99, five
-- vehicles per mobile number, a number-plate game, and prices "inclusive of
-- applicable taxes unless stated otherwise". None of that is true any more.
--
-- Terms that contradict what a customer is actually charged are worse than no
-- terms: they are the first thing produced in a dispute, and they would be
-- produced against us. So this migration rewrites the clauses that moved,
-- retires the ones for features that no longer exist, and adds the two
-- commitments the new design makes and the old Terms never mentioned — what we
-- deliberately do not show, and that we never message first.
--
-- Clauses are updated in place, keeping their ids, so anyone who read clause 16
-- last month finds the same subject there today. Retired clauses are
-- deactivated rather than deleted: they are what someone agreed to at the time.

BEGIN;

/* ------------------------------------------------ what the product now is */

UPDATE terms_and_conditions SET
  title = 'Watch Subscription',
  description = 'Watch is a paid, per-vehicle monitoring plan. The first 28 days cost '
    || 'Rs.49 per vehicle and every renewal costs Rs.29 per vehicle. Both prices are '
    || 'inclusive of GST and of payment-gateway charges — the amount shown is the amount '
    || 'you pay, with nothing added at checkout. You may monitor up to four vehicles per '
    || 'mobile number; for five or more, please write to support@gaadipe.in. There is NO '
    || 'auto-charge and NO auto-renewal: Watch simply lapses at the end of its term '
    || 'unless you choose to renew. A subscription that has lapsed and is restarted is '
    || 'charged at the first-payment price again.',
  version = '2.0', effective_from = CURRENT_DATE, modified_at = now()
WHERE id = 16;

UPDATE terms_and_conditions SET
  title = 'Free Trial',
  description = 'We may offer a free 7-day trial with full monitoring, limited to one '
    || 'trial per mobile number. No payment is taken for the trial and no payment '
    || 'instrument is required to start it. The trial ends automatically after seven '
    || 'days; nothing is charged unless you choose to subscribe.',
  version = '2.0', effective_from = CURRENT_DATE, modified_at = now()
WHERE id = 17;

UPDATE terms_and_conditions SET
  title = 'Fees, Plans and Payments',
  description = 'Prices are shown in Indian Rupees and are inclusive of GST. A tax '
    || 'invoice is issued for every payment. Payments are processed by our payment '
    || 'gateway partner; GaadiPe does not store your card, UPI or banking credentials. '
    || 'Free checks may be offered from time to time and may be withdrawn or limited '
    || 'without notice.',
  version = '2.0', effective_from = CURRENT_DATE, modified_at = now()
WHERE id = 7;

UPDATE terms_and_conditions SET
  description = 'For trial and Watch vehicles, GaadiPe periodically re-checks '
    || 'Government-sourced data and notifies you of new challans and of insurance, '
    || 'emission (PUCC), fitness and road-tax expiries. Monitoring is a best-effort '
    || 'convenience: source data may be delayed or incomplete, and GaadiPe does not '
    || 'guarantee that every event is detected or notified. Always verify important '
    || 'matters with the RTO or the relevant authority.',
  version = '2.0', effective_from = CURRENT_DATE, modified_at = now()
WHERE id = 18;

-- The number-plate game no longer exists.
UPDATE terms_and_conditions SET is_active = false, modified_at = now()
WHERE id IN (19, 20);

/* ----------------------------------------------- the two new commitments */

-- Said plainly because it is the answer to "can someone watch my car?", and
-- because a promise not written down is not a promise.
INSERT INTO terms_and_conditions
  (id, title, description, display_order, version, effective_from) VALUES
(21, 'Information We Deliberately Do Not Show',
 'GaadiPe never displays the registered owner''s name, the chassis number or the engine '
 || 'number of any vehicle, to anyone, on any screen — even to a paying subscriber, and '
 || 'even for a vehicle they own. We also do not show FASTag toll-crossing history; only '
 || 'the tag status and balance are shown. We cannot verify who owns a vehicle from a '
 || 'registration number alone, so we do not show anything that would identify or track '
 || 'its owner. Document validity and challan information are shown because they are '
 || 'what the service exists to report.', 21, '2.0', CURRENT_DATE),

(22, 'We Do Not Message You First',
 'GaadiPe does not send unsolicited messages. We reply when you message us, and we send '
 || 'alerts and reminders only for vehicles you have added to a trial or a paid '
 || 'subscription — that being the service you have asked for. We do not sell, rent or '
 || 'share your mobile number, and you can stop alerts at any time by replying STOP or '
 || 'writing to support@gaadipe.in.', 22, '2.0', CURRENT_DATE)
ON CONFLICT (id) DO NOTHING;

COMMIT;
