-- 049_instant_quiz_referral.sql — a second referral reward (user, 2026-09-22).
--
--   The parent, through the customer's link, buys:
--     QuizPe premium (Rs.99+)        → the customer gets a FULL REPORT FREE (as before)
--     QuizPe's Rs.9 + GST quiz       → the customer's next full report costs
--                                      Rs.9 + GST (Rs.10.62) instead of Rs.19
--   One reward per parent, whichever they buy first.
--
-- The reduced price is the report price when the reward is used, GST-inclusive
-- like every GaadiPe price: 1062 paise = Rs.9.00 taxable + Rs.1.62 GST.

ALTER TABLE report_credits  ADD COLUMN IF NOT EXISTS price_paise  integer;   -- set for reward = 'report_at_price'
ALTER TABLE quizpe_referrals ADD COLUMN IF NOT EXISTS reward_kind text;      -- free_report | report_at_price
CREATE INDEX IF NOT EXISTS idx_report_credits_payment ON report_credits (payment_id) WHERE payment_id IS NOT NULL;

INSERT INTO app_settings (key, value) VALUES
  ('referral_instant_enabled',             'true'),
  ('referral_instant_report_price_paise',  '1062')   -- Rs.9 + 18% GST
ON CONFLICT (key) DO NOTHING;

/* A NEW Terms section; the existing Referral Offer text is not changed. */
INSERT INTO terms_and_conditions (id, title, description, display_order, is_active, version, effective_from)
SELECT m.nid, 'Referral Offer — QuizPe Instant Quiz',
       'If a parent opens QuizPe through your referral link and, within 30 days, buys QuizPe''s Instant Quiz (Rs.9 plus GST) instead of a premium plan, you receive a reduced price on your next GaadiPe full vehicle report: Rs.9 plus GST (Rs.10.62) instead of Rs.19, to be used within 90 days. The reduced price is applied automatically at checkout and a GST tax invoice is issued for the amount you pay. Each parent earns one reward only — the first of an Instant Quiz or a premium plan they buy — and the same conditions, exclusions and monthly limit as the Referral Offer apply.',
       m.nord, true, '1.3', CURRENT_DATE
  FROM (SELECT coalesce(max(id), 0) + 1 AS nid, coalesce(max(display_order), 0) + 1 AS nord FROM terms_and_conditions) m
 WHERE NOT EXISTS (SELECT 1 FROM terms_and_conditions WHERE title = 'Referral Offer — QuizPe Instant Quiz');
