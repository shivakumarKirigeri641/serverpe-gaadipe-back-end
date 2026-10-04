-- 107_gift_rounds.sql — automatic gifts for paying customers (src/admin/gifts.js):
-- which gift round a free report came from, so each paying customer receives
-- a round's gift once, the first time they come back while it is on.

ALTER TABLE report_credits ADD COLUMN IF NOT EXISTS campaign text;
CREATE INDEX IF NOT EXISTS report_credits_campaign ON report_credits (user_id, campaign) WHERE campaign IS NOT NULL;
