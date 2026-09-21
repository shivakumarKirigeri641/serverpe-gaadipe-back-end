-- 045_quizpe_referral.sql — refer QuizPe to a parent, get a free full report
-- (user, 2026-09-21), the owner's per-vehicle report switch, QuizPe marketing
-- consent, and the policy sections that go with them.
--
-- NOTHING IS SENT TO THE REFERRED PARENT by GaadiPe or QuizPe. The customer
-- shares from their own phone; GaadiPe stores the number only to see — through
-- a read-only login on QuizPe's database — whether that parent bought QuizPe
-- premium, and credits the referrer a free report.

/* ─────────────────────────────────────────────────────────── referrals ── */

CREATE TABLE IF NOT EXISTS quizpe_referrals (
  id               bigserial PRIMARY KEY,
  referrer_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_name      text,
  parent_mobile    text,                 -- deleted (NULL) once the referral expires or is rewarded
  mobile_masked    text        NOT NULL, -- kept as the record: 98xxxxx415
  mobile_hash      text        NOT NULL, -- sha256 of the 10 digits: duplicates and first-referrer-wins
  status           text        NOT NULL DEFAULT 'pending',  -- pending | rewarded | expired | not_eligible | revoked
  status_reason    text,
  consent_text     text        NOT NULL, -- the exact words the referrer ticked
  quizpe_parent_id bigint,
  quizpe_payment   text,                 -- QuizPe's Razorpay payment id that earned the reward
  quizpe_amount    numeric(10,2),
  rewarded_at      timestamptz,
  expires_at       timestamptz NOT NULL,
  last_checked_at  timestamptz,
  ip               text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quizpe_referrals_pending  ON quizpe_referrals (id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_quizpe_referrals_referrer ON quizpe_referrals (referrer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quizpe_referrals_hash     ON quizpe_referrals (mobile_hash, created_at);

/* A free full report: earned by a referral, or granted by the owner. */
CREATE TABLE IF NOT EXISTS report_credits (
  id           bigserial PRIMARY KEY,
  user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source       text        NOT NULL,          -- referral | admin
  referral_id  bigint      REFERENCES quizpe_referrals(id) ON DELETE SET NULL,
  reward       text        NOT NULL DEFAULT 'free_report',
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  used_reg_no  text,
  payment_id   bigint      REFERENCES payments(id) ON DELETE SET NULL,
  revoked_at   timestamptz,
  revoked_reason text,
  notified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_report_credits_user ON report_credits (user_id, created_at DESC);

/* QuizPe may message this GaadiPe customer — only with their own, separate consent. */
ALTER TABLE users ADD COLUMN IF NOT EXISTS quizpe_consent_at       timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS quizpe_consent_text     text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS quizpe_consent_withdrawn_at timestamptz;

INSERT INTO app_settings (key, value) VALUES
  ('report_unlock',              'both'),         -- pay | both | refer
  ('referral_enabled',           'true'),
  ('referral_reward',            'free_report'),  -- free_report (later: flat_off)
  ('referral_flat_off_paise',    '1000'),         -- for flat_off: ₹10
  ('referral_monthly_cap',       '10'),
  ('referral_pending_max',       '10'),
  ('referral_window_days',       '30'),
  ('referral_credit_valid_days', '90'),
  ('referral_min_quizpe_rupees', '99'),
  ('referral_check_minutes',     '10'),
  ('admin_report_access_enabled','true')
ON CONFLICT (key) DO NOTHING;

/* ───────────────────────────────────────────────────── the email policy ── */

CREATE TABLE IF NOT EXISTS email_policy (
  id             smallint     NOT NULL PRIMARY KEY,
  title          varchar(255) NOT NULL,
  description    text         NOT NULL,
  display_order  smallint     NOT NULL,
  is_active      boolean      NOT NULL DEFAULT true,
  created_at     timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified_at    timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version        varchar(20)  NOT NULL DEFAULT '1.0',
  effective_from date         NOT NULL DEFAULT CURRENT_DATE
);

/*
 * NEW SECTIONS ONLY. Existing policy text is never edited here: each clause is
 * appended after the last one, and only if a clause with that title is not
 * already there — so this can run again safely, and an owner's own edits in the
 * panel are left alone.
 */
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    -- EMAIL POLICY (a new page)
    ('email_policy', 'Emails We Send',
     'GaadiPe sends email only for your account and your vehicles: a one-time link to confirm your address; for a full report you have bought or received, a daily vehicle update during its alert period (document expiry, new challans, loan, blacklist, NOC and FASTag status); for vehicles you checked without a report, a short summary about once every four days; and notices about your referral rewards. We do not send newsletters or third-party advertising.'),
    ('email_policy', 'Confirming Your Address',
     'Nothing is emailed to an address until its owner confirms it by clicking the link we send. This protects you if an address is mistyped: vehicle information is never sent to an unconfirmed address.'),
    ('email_policy', 'When Emails Arrive',
     'Vehicle updates are sent once a day, in the evening (India time). You will not receive more than one daily update and one summary per day. Confirmation links are sent straight away.'),
    ('email_policy', 'What the Emails Contain',
     'Emails show the same Government-sourced information as your GaadiPe account, from the most recent record we fetched, with the date of that check. A daily update for a report shows the full record; a summary for a vehicle without a report shows only the basic view. Vehicle and challan details come from the Government of India''s Parivahan records (VAHAN and e-Challan); where anything differs from your documents, the RTO''s record prevails.'),
    ('email_policy', 'Unsubscribing',
     'Every update email has an Unsubscribe link, and supporting mail apps show a one-click unsubscribe button. Unsubscribing stops vehicle updates to that address at once; it does not close your account or affect your reports and invoices. You can subscribe again from the same link, or change your address under Profile.'),
    ('email_policy', 'Security',
     'GaadiPe emails come from a no-reply address. We will never ask you by email for a sign-in code, password, card, UPI or bank details. If an email claiming to be from GaadiPe asks for these, do not respond, and report it to support@gaadipe.in.'),
    ('email_policy', 'Your Email Address',
     'We use your email address only to send the emails described here, your reports and your invoices. We do not sell it or share it with anyone for their marketing. It is held under our Privacy Policy and deleted with your account under our Data Deletion Policy, except where invoice records must be kept by law.'),

    -- TERMS
    ('terms_and_conditions', 'Referral Offer',
     'You may refer QuizPe (a product of ServerPe App Solutions) to a parent you know. When that parent buys a QuizPe premium plan of Rs.99 or more within 30 days of your referral, using the mobile number you entered, you receive one free GaadiPe full vehicle report, to be used within 90 days. A number already registered with QuizPe, your own number, or a number already referred by someone else does not qualify. Rewards have no cash value, cannot be exchanged or transferred, and are limited to 10 per calendar month. GaadiPe may change or end this offer at any time; rewards already earned will be honoured.'),
    ('terms_and_conditions', 'Referring Responsibly',
     'By referring someone you confirm that you know them and that they are happy for you to share their mobile number with GaadiPe for this referral. You send the invitation yourself, from your own phone; neither GaadiPe nor QuizPe contacts the person you refer. Referrals made without the person''s agreement, in bulk, or to obtain rewards unfairly may be cancelled, together with any rewards.'),
    ('terms_and_conditions', 'Free Reports',
     'A free full report, whether earned through a referral or granted by GaadiPe, is the same as a paid one: the report, its download period and its alert period. As nothing is paid for it, no GST tax invoice is issued. GaadiPe may withdraw a free report that was obtained in breach of these terms.'),
    ('terms_and_conditions', 'Email Communications',
     'If you give us your email address and confirm it, we email you as described in our Email Policy. You can unsubscribe at any time using the link in any update email.'),
    ('terms_and_conditions', 'Messages from QuizPe',
     'QuizPe, a product of ServerPe App Solutions, may send you messages about QuizPe only if you choose to allow it, using the separate, optional checkbox in your GaadiPe profile. Allowing it is not a condition of using GaadiPe, and you can withdraw it at any time from the same place.'),

    -- PRIVACY
    ('privacy_policy', 'Referral Information',
     'When you refer someone to QuizPe, we store the name and mobile number you enter only to confirm whether they join QuizPe and to credit your reward. We never contact them. To confirm this, GaadiPe looks up that number in QuizPe''s records (QuizPe is also operated by ServerPe App Solutions) using read-only access, and learns only whether it joined and bought a premium plan. Numbers that do not join are deleted after 30 days; for rewarded referrals we keep only a masked number (for example 98xxxxx415) as the record.'),
    ('privacy_policy', 'Email Address and Updates',
     'If you give us your email address, we use it to send the emails described in our Email Policy, your reports and your invoices. We send nothing to an address until you confirm it, and you can unsubscribe at any time.'),
    ('privacy_policy', 'Sharing with QuizPe, Only with Your Consent',
     'Your mobile number is shared with QuizPe for its messages only if you tick the optional QuizPe consent in your profile. We record the time and the exact words you agreed to. If you withdraw consent, we stop sharing your number from that moment and tell QuizPe to stop messaging you.'),

    -- REFUND
    ('refund_policy', 'Free and Referral Reports',
     'A free report, whether earned through a referral or granted by GaadiPe, is not a paid purchase, so no refund or cash value applies to it. An unused referral reward expires 90 days after it is earned.'),
    ('refund_policy', 'Reports Withdrawn by GaadiPe',
     'In rare cases GaadiPe may withdraw access to a report, for example on a legal request or to stop misuse. If a paid report is withdrawn for a reason other than a breach of our terms by you, the amount you paid for it will be refunded to your original payment method.'),

    -- CONSENT
    ('consent_policy', 'Email Updates',
     'Giving and confirming your email address is your consent to the emails described in our Email Policy. Unsubscribing withdraws that consent for vehicle updates.'),
    ('consent_policy', 'Referring Someone',
     'When you refer someone, you confirm that they agree to you sharing their mobile number with GaadiPe for that referral. We record the exact words you ticked and the time.'),
    ('consent_policy', 'Messages from QuizPe (Optional)',
     'You may choose to let QuizPe, a product of ServerPe App Solutions, send you messages about QuizPe. This consent is separate and optional: the box is never ticked for you, it is not needed to use GaadiPe, and you can withdraw it at any time from your profile. We record the exact words you agreed to and the time.'),

    -- DATA DELETION
    ('data_deletion_policy', 'Referral Numbers',
     'The mobile number of someone you referred is deleted automatically when the referral expires (30 days) or when the reward is credited; only a masked number is kept as the record of the reward.'),
    ('data_deletion_policy', 'Email Address',
     'Your email address is deleted with your account. Unsubscribing stops our emails but keeps the address on your account until you remove or change it under Profile.'),

    -- CANCELLATION
    ('cancellation_policy', 'Stopping Email Updates',
     'You can stop vehicle update emails at any time with the Unsubscribe link in any update email, without cancelling anything else. Your reports, alerts on your account and invoices are not affected.'),

    -- DELIVERY
    ('delivery_policy', 'Free Reports',
     'A free report is delivered the same way as a paid one: in your GaadiPe account as soon as you use your reward, with its download period and alert period starting then.'),
    ('delivery_policy', 'Email Updates',
     'Daily vehicle updates are delivered by email in the evening (India time) to your confirmed address. Delivery depends on your email provider; please check your spam folder and add our sender to your contacts.'),

    -- LIABILITY
    ('liability_policy', 'Emails and Referral Rewards',
     'Emails carry the same Government-sourced information as your account, as of the date shown, and the same limitations apply. Referral rewards depend on QuizPe''s own records of a qualifying purchase; where those records do not show one, no reward is due.')
  ) AS v(tbl, ttl, body)
  LOOP
    EXECUTE format(
      'INSERT INTO %1$I (id, title, description, display_order, is_active, version, effective_from)
       SELECT m.nid, %2$L, %3$L, m.nord, true, %4$L, CURRENT_DATE
         FROM (SELECT coalesce(max(id), 0) + 1 AS nid, coalesce(max(display_order), 0) + 1 AS nord FROM %1$I) m
        WHERE NOT EXISTS (SELECT 1 FROM %1$I WHERE title = %2$L)',
      c.tbl, c.ttl, c.body, '1.1');
  END LOOP;
END $$;
