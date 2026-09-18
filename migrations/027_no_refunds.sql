-- 027_no_refunds.sql — all sales are final.
--
-- The report is produced and delivered the moment it is paid for: the data is
-- fetched, the PDF is generated and it is sent. There is nothing to return, and
-- nothing that can be un-read. So the policy is now simply that a completed
-- purchase is not refunded, and it says so in the words a customer will read
-- before paying rather than in a paragraph they find afterwards.
--
-- The old clauses are DEACTIVATED, not deleted: a customer who paid last month
-- bought under those terms, and the record of what was published then has to
-- survive. The public endpoint only serves is_active rows.
--
-- ONE EXCEPTION IS KEPT, and it is deliberate: money taken with nothing
-- delivered at all. That is not a refund policy, it is not charging for
-- something that did not happen — and every payment gateway, and the Consumer
-- Protection Act, expects it. If you want even that removed, it is one clause
-- to hide in the admin panel; see the note in the handover.

/*
 * FIRST, SOMETHING THAT SHOULD HAVE BEEN TRUE ALL ALONG.
 *
 * The policy tables were seeded with explicit ids and their id column has no
 * default, so ANY insert without an id fails — including "Add a clause" in the
 * admin panel, and including this migration. Each table gets a sequence set
 * past its highest existing id, so clauses can be added from the panel and from
 * here without anybody having to know what the last id was.
 */
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'terms_and_conditions', 'privacy_policy', 'refund_policy', 'liability_policy',
    'consent_policy', 'cancellation_policy', 'delivery_policy', 'data_deletion_policy',
    'partner_policy'
  ] LOOP
    IF to_regclass(t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I OWNED BY %I.id', t || '_id_seq', t);
    EXECUTE format('SELECT setval(%L, coalesce((SELECT max(id) FROM %I), 0) + 1, false)',
                   t || '_id_seq', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET DEFAULT nextval(%L)', t, t || '_id_seq');
  END LOOP;
END $$;

UPDATE refund_policy SET is_active = false, modified_at = now();

INSERT INTO refund_policy (title, description, display_order, version, effective_from, is_active) VALUES
('All Sales Are Final',
 'GaadiPe reports are digital and are delivered the instant payment succeeds. Once a report has been '
 || 'delivered, the purchase is complete and the amount paid is not refundable, in whole or in part. '
 || 'Please check the vehicle number shown on the payment page before paying — the free check exists so '
 || 'that you can see exactly which vehicle you are buying a report for.',
 1, '2.0', CURRENT_DATE, true),

('What You See Before You Pay',
 'Every vehicle can be checked free of charge before any payment. The free check shows the vehicle, its '
 || 'registration details and the expiry dates of its documents, and states plainly what the paid report '
 || 'adds. Nothing is hidden about what is being sold, and no payment is taken before you have seen that.',
 2, '2.0', CURRENT_DATE, true),

('Refunds Are Not Given For',
 'A report is not refunded because the Government record shows something you did not expect or hoped '
 || 'would be different; because a record at the source is outdated, incomplete or missing; because you '
 || 'entered a vehicle number other than the one you meant; because you changed your mind after paying; '
 || 'or because monitoring produced no alerts during its term. None of these is a failure of the service: '
 || 'GaadiPe reproduces the Government record as it stands, and a quiet monitoring term means nothing '
 || 'went wrong with the vehicle.',
 3, '2.0', CURRENT_DATE, true),

('If Nothing Was Delivered',
 'If an amount is taken and no report is delivered to you at all — for example a duplicate payment for '
 || 'the same vehicle, or a technical failure on our side that we cannot put right — that payment is '
 || 'returned in full. Write to support@gaadipe.in within 7 days with the registered mobile number, the '
 || 'vehicle number and the payment reference. Approved returns are initiated within 3 business days to '
 || 'the original payment method and usually appear within 5 to 7 business days, depending on your bank.',
 4, '2.0', CURRENT_DATE, true),

('Failed or Pending Payments',
 'If an amount is debited but the payment does not complete, the payment gateway normally reverses it '
 || 'automatically within your bank''s standard cycle. This is handled by your bank and the gateway, not '
 || 'by GaadiPe. If the amount is not credited back within that period, write to support@gaadipe.in with '
 || 'the transaction reference and we will trace it with the gateway.',
 5, '2.0', CURRENT_DATE, true),

('Chargebacks',
 'Please write to us before raising a chargeback with your bank. A chargeback raised without giving us '
 || 'the opportunity to look at what happened may result in access being suspended while the matter is '
 || 'investigated with the gateway.',
 6, '2.0', CURRENT_DATE, true);

-- The Terms carried the old Rs.59 monitoring plan. A price in a published
-- document that is not the price charged is the first thing produced in a
-- dispute, so it is replaced with what is actually sold today.
UPDATE terms_and_conditions SET is_active = false, modified_at = now() WHERE id = 16;

INSERT INTO terms_and_conditions (title, description, display_order, version, effective_from, is_active)
VALUES (
 'What You Are Buying',
 'The full vehicle report costs Rs.19 per vehicle, inclusive of GST and of payment-gateway charges — the '
 || 'amount shown is the amount you pay, with nothing added at checkout. One payment covers one vehicle '
 || 'and buys three things: the full report as a PDF, which you may download again for 7 days; the detail '
 || 'behind the free check, being loan or hypothecation status, blacklist and NOC status, the challan list '
 || 'with offence and place, and masked policy and certificate numbers; and 28 days of monitoring of that '
 || 'vehicle, during which you are messaged if a new challan appears or a document is close to expiring. '
 || 'There is NO auto-charge and NO auto-renewal: monitoring simply stops at the end of its term, and no '
 || 'card or payment instrument is stored. Checking a vehicle remains free, subject to a daily limit. '
 || 'Once a report has been delivered the purchase is final; please see the Refund Policy.',
 (SELECT coalesce(max(display_order), 0) + 1 FROM terms_and_conditions),
 '3.0', CURRENT_DATE, true);
