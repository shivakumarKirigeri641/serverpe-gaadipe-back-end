-- 009_partner_policy.sql — the Partner Commission & Payout Policy.
--
-- WHY THIS IS A DOCUMENT AND NOT JUST CODE: a referral programme is the one
-- feature where the rules must be agreed BEFORE anyone earns anything. Once a
-- partner has Rs.300 accrued, every rule that was never written down becomes an
-- argument you lose.
--
-- Three clauses here are load-bearing for legality, not merely for clarity:
--
--   * No joining fee, and earnings only from a real customer's real payment
--     (clauses 3, 4). Single level, with no reward for recruiting other
--     partners (clause 5). Together these are what separate a referral
--     programme from a money-circulation scheme under the Prize Chits and
--     Money Circulation Schemes (Banning) Act, 1978.
--
--   * TDS and the partner's own tax position (clauses 12, 13). Commission is
--     the partner's income; deduction at source is our obligation whether or
--     not anyone mentions it, so it is mentioned.
--
--   * Clawback (clause 10). Reversing commission on a refund or chargeback is
--     fair, but only enforceable if it was agreed in advance.
--
-- One rule was deliberately REMOVED before this shipped: holding first-payment
-- commission until the customer renewed, but only for referrals of five or more
-- vehicles. A conditional like that is an invitation to game the condition —
-- split one customer into two smaller referrals, or pad a referral to look like
-- a fleet — and it made the pitch unrepeatable. It was also redundant: payouts
-- run on the 5th for the previous month, so every commission already waits
-- between 5 and 35 days, which is longer than a refund or dispute takes to
-- surface, and clause 10 reverses anything that goes bad afterwards.
--
-- Rates match 008: Rs.5 per vehicle on a first payment, Rs.2.50 per vehicle on
-- every renewal. The text says "per vehicle" throughout and never a percentage,
-- because a partner who cannot repeat the rule from memory cannot sell it.

BEGIN;

CREATE TABLE IF NOT EXISTS partner_policy (
    id smallint NOT NULL,
    title character varying(255) NOT NULL,
    description text NOT NULL,
    display_order smallint NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    version character varying(20) DEFAULT '1.0'::character varying NOT NULL,
    effective_from date DEFAULT CURRENT_DATE NOT NULL
);
ALTER TABLE partner_policy DROP CONSTRAINT IF EXISTS partner_policy_pkey;
ALTER TABLE partner_policy ADD CONSTRAINT partner_policy_pkey PRIMARY KEY (id);

INSERT INTO partner_policy (id, title, description, display_order) VALUES
(1, 'About the Partner Programme',
 'The GaadiPe Partner Programme lets an individual or business introduce new customers to GaadiPe and earn a commission when those customers pay for a Watch subscription. The programme is operated by ServerPe App Solutions (GSTIN 29BSMPK7696H1ZT). Participation is voluntary and may be ended by either side at any time.', 1),

(2, 'Who Can Join',
 'You must be at least 18 years of age, resident in India, and capable of entering into a legally binding contract under the Indian Contract Act, 1872. You must provide a valid mobile number, a PAN, and bank or UPI details in your own name. Payouts are made only to an account matching the partner''s own name.', 2),

(3, 'No Joining Fee',
 'Joining the Partner Programme is completely free. GaadiPe does not charge any registration fee, deposit, kit charge, training fee, renewal fee or any other amount to become or remain a partner, and no partner may collect any such amount from anyone else in GaadiPe''s name.', 3),

(4, 'What Earns Commission',
 'Commission is earned only when a customer you introduced makes a genuine, successful payment for a GaadiPe Watch subscription. Sign-ups, free trials, enquiries and unpaid registrations earn nothing. A customer is treated as introduced by you only if they were not already a GaadiPe customer and they arrived through your referral link or referral code.', 4),

(5, 'Single Level Only',
 'The programme has exactly one level. You earn from the customers you introduce, and from nothing else. There is no reward for enrolling other partners, no team, no downline, no hierarchy, and no earnings derived from another partner''s referrals. GaadiPe is not, and must not be represented as, a chain, network, binary, matrix or multi-level marketing scheme.', 5),

(6, 'Commission Rates',
 'Commission is paid per vehicle, not as a percentage of the invoice. You earn Rs.5.00 for each vehicle on a customer''s first payment, and Rs.2.50 for each vehicle on every renewal that customer pays thereafter, for as long as they keep renewing. A customer with four vehicles therefore earns you Rs.20.00 on their first payment and Rs.10.00 on every renewal. When an existing customer adds a further vehicle, that vehicle''s first payment earns Rs.5.00. Commission is calculated on the subscription value excluding GST.', 6),

(7, 'Rates May Change',
 'GaadiPe may revise commission rates, and will publish the revised rates on this page before they take effect. Commission already earned under an earlier rate is honoured at that rate. Continuing to introduce customers after a change constitutes acceptance of the revised rates.', 7),

(8, 'No Self-Referral',
 'You cannot earn commission on yourself. This includes subscriptions taken in your own name, on your own mobile number, for vehicles registered to you or to your immediate family, or paid for using a card, UPI ID or bank account belonging to you. Referrals that exist only to obtain a discount on your own subscription are not genuine referrals, and any commission arising from them will be cancelled.', 8),

(9, 'What a Referral Is Worth at Each Payment',
 'Commission is always calculated from the vehicles actually paid for on that payment. If a customer subscribes for three vehicles, you earn for three, whatever number was discussed beforehand. If they later add a vehicle, that vehicle earns a first-payment commission. If they renew with fewer vehicles, the renewal commission follows the smaller number. Nothing is earned for a vehicle nobody has paid for.', 9),

(10, 'Refunds, Chargebacks and Reversals',
 'If a payment on which commission was earned is refunded, reversed, charged back or found to be fraudulent, the corresponding commission is reversed. If it has already been paid to you, the amount is recovered from your next payout. Repeated chargebacks arising from your referrals may result in removal from the programme.', 10),

(11, 'How and When You Are Paid',
 'Payouts are made monthly, on or about the 5th of each month, for commission released up to the end of the previous month, provided your balance is at least Rs.50.00. Any balance below that threshold carries forward. Whatever remains outstanding is paid out once a year in April regardless of the threshold, so that earnings are never held indefinitely. Payouts are made by bank transfer or UPI to the details in your partner account; you are responsible for keeping them correct.', 11),

(12, 'Tax Deducted at Source',
 'Commission is income in your hands. GaadiPe deducts tax at source on commission payments where required under section 194H of the Income-tax Act, 1961, at the rate then in force, and at the higher rate prescribed under section 206AA where a valid PAN has not been provided. Amounts deducted are deposited against your PAN and will appear in your Form 26AS. Figures shown in your partner account are before such deduction.', 12),

(13, 'Your Own Tax and GST Position',
 'You are responsible for declaring commission income in your own income-tax return. If you are registered under GST, providing referral services is a supply by you and you are responsible for your own GST compliance, including raising an invoice on GaadiPe where required. GaadiPe does not provide tax advice.', 13),

(14, 'Honest Promotion',
 'You may introduce GaadiPe to people you know, on your own channels, and in person. You must not send unsolicited bulk messages, calls or emails; must not use GaadiPe''s name to run advertisements without written permission; must not impersonate GaadiPe, ServerPe App Solutions, any RTO or any Government body; and must not promise anything GaadiPe does not offer, including guaranteed earnings, fines being waived, records being corrected, or any outcome with an RTO. GaadiPe is an information service and no partner may represent otherwise.', 14),

(15, 'Fraud and Misuse',
 'Registering vehicles or customers that do not exist, using stolen or borrowed payment instruments, creating accounts to farm commission, manipulating referral attribution, or any other attempt to obtain commission not genuinely earned will result in immediate forfeiture of all accrued commission and removal from the programme, without prejudice to any other remedy available in law.', 15),

(16, 'Not Employment or Agency',
 'The Partner Programme does not create any employment, partnership, agency, franchise or joint-venture relationship between you and ServerPe App Solutions. You act independently, at your own cost, and have no authority to enter into any commitment, collect any payment, or make any representation on GaadiPe''s behalf.', 16),

(17, 'Suspension, Dormancy and Termination',
 'You may leave the programme at any time; commission genuinely earned before you leave is paid in the normal cycle. GaadiPe may suspend or end your participation, with reasons where it is able to give them, if this policy is breached or the programme is misused. If a partner account has no activity and no balance for twenty-four consecutive months it may be closed as dormant, after notice to your registered mobile number.', 17),

(18, 'Grievances and Jurisdiction',
 'Questions or complaints about commission or payouts may be sent to support@gaadipe.in and will be responded to within 30 days by the Grievance Officer, Shivakumar Kirigeri, Proprietor, ServerPe App Solutions, The Orchard, HMT Watch Factory Main Road, HMT Estate, Jalahalli, Bangalore - 560013. This policy is governed by the laws of India and disputes are subject to the exclusive jurisdiction of the courts at Bengaluru, Karnataka.', 18)
ON CONFLICT (id) DO NOTHING;

COMMIT;
