-- 046_referral_links.sql — the QuizPe referral becomes ONE PERSONAL LINK per
-- GaadiPe customer (user, 2026-09-21), replacing "type the parent's number".
--
--   gaadipe.in/q/<code>  →  opens QuizPe's WhatsApp with
--   "Hi QuizPe 👋 (GaadiPe ref GP-<code>)" typed; the parent presses Send.
--
-- GaadiPe then reads — through two read-only views in QuizPe's database, see
-- scripts/quizpe-readonly.sql — which numbers sent a GP- code, and whether that
-- number bought QuizPe premium within 30 days after. The referrer never types
-- anyone's number, and GaadiPe never stores one: only a hash (to match) and a
-- masked form (98xxxxx415) as the record.

CREATE TABLE IF NOT EXISTS referral_links (
  id           bigserial PRIMARY KEY,
  user_id      bigint      NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code         text        NOT NULL UNIQUE,
  is_active    boolean     NOT NULL DEFAULT true,
  disabled_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reset_at     timestamptz
);

/* Taps on a link — counts and abuse signals only (the address is hashed). */
CREATE TABLE IF NOT EXISTS referral_clicks (
  id          bigserial PRIMARY KEY,
  link_id     bigint      NOT NULL REFERENCES referral_links(id) ON DELETE CASCADE,
  outcome     text        NOT NULL,     -- opened | own_link | inactive
  ip_hash     text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_clicks_link ON referral_clicks (link_id, created_at DESC);

/* A referral is now an ATTRIBUTION found on QuizPe: this number sent this code at this time. */
ALTER TABLE quizpe_referrals ALTER COLUMN consent_text DROP NOT NULL;
ALTER TABLE quizpe_referrals ADD COLUMN IF NOT EXISTS link_id   bigint REFERENCES referral_links(id) ON DELETE SET NULL;
ALTER TABLE quizpe_referrals ADD COLUMN IF NOT EXISTS code      text;
ALTER TABLE quizpe_referrals ADD COLUMN IF NOT EXISTS tapped_at timestamptz;
-- One attribution per parent number, ever: the first GaadiPe link a parent used wins.
CREATE UNIQUE INDEX IF NOT EXISTS uq_quizpe_referrals_link_mobile ON quizpe_referrals (mobile_hash) WHERE link_id IS NOT NULL;

INSERT INTO app_settings (key, value) VALUES
  ('referral_link_base',          ''),     -- empty = PUBLIC_SITE_URL/q/<code>
  ('referral_taps_per_day_alert', '30')    -- distinct numbers a day on one link before you are told
ON CONFLICT (key) DO NOTHING;
DELETE FROM app_settings WHERE key = 'referral_pending_max';

/*
 * The policy sections added by 045 described typing a parent's number. They
 * are REWORDED for the link — only while they still hold 045's exact text, so
 * an owner's own edit in the panel is never overwritten.
 */
UPDATE terms_and_conditions SET description =
  'Signed-in customers may join the QuizPe referral programme (QuizPe is a product of ServerPe App Solutions) and receive one personal link to share with anyone. When a parent opens QuizPe through your link and, within 30 days of doing so, buys a QuizPe premium plan of Rs.99 or more, you receive one free GaadiPe full vehicle report, to be used within 90 days. This applies to a parent new to QuizPe, a parent whose earlier plan has lapsed, a parent on a free trial, and a parent who had only messaged QuizPe before; it does not apply to a parent whose premium plan is running when they open your link, or to your own number. If a parent opens more than one GaadiPe link, the first one counts. Rewards have no cash value, cannot be exchanged or transferred, and are limited to 10 per calendar month. GaadiPe may change or end this offer, or deactivate a link, at any time; rewards already earned will be honoured.',
  modified_at = now()
 WHERE title = 'Referral Offer' AND description LIKE 'You may refer QuizPe%';

UPDATE terms_and_conditions SET description =
  'Joining the referral programme requires your agreement that QuizPe may send you messages about QuizPe; GaadiPe itself remains fully available without joining. You share your link yourself; GaadiPe sends nothing to anyone you share it with, and a parent contacts QuizPe only by choosing to send the message the link prepares. Links shared as spam, used to obtain rewards unfairly, or used on your own number may be deactivated and their rewards cancelled.',
  modified_at = now()
 WHERE title = 'Referring Responsibly' AND description LIKE 'By referring someone%';

UPDATE privacy_policy SET description =
  'When a parent opens QuizPe through your referral link, the message they send to QuizPe carries your link''s code. To credit your reward, GaadiPe reads — with read-only access, and only for messages carrying a GaadiPe code — which mobile number sent the code, when, and whether that number bought a QuizPe premium plan (QuizPe is also operated by ServerPe App Solutions). GaadiPe does not store that number: it keeps a one-way hash, to match it, and a masked form (for example 98xxxxx415) as the record of your reward. You never give us anyone else''s number.',
  modified_at = now()
 WHERE title = 'Referral Information' AND description LIKE 'When you refer someone%';

UPDATE consent_policy SET title = 'Referral Programme', description =
  'Joining the referral programme is optional. To join, you agree that QuizPe, a product of ServerPe App Solutions, may send you messages about QuizPe; we record the exact words and the time. You can withdraw this at any time from your profile: your link then stops working for new parents, and rewards you have already earned remain yours.',
  modified_at = now()
 WHERE title = 'Referring Someone' AND description LIKE 'When you refer someone%';

UPDATE data_deletion_policy SET description =
  'GaadiPe does not store the mobile numbers of parents who use your referral link — only a one-way hash and a masked number as the record of a reward. Taps on your link are counted with the visitor''s address hashed, not stored.',
  modified_at = now()
 WHERE title = 'Referral Numbers' AND description LIKE 'The mobile number of someone you referred%';
