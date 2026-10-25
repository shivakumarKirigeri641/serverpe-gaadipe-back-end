-- 211_subscriber_check_cap.sql (user, 2026-10-25: "subscribers no limit? I need a cap, otherwise it is a loss
-- for me"). A fleet or other subscription plan had unlimited vehicle checks, and a private vehicle's RC costs
-- ₹2.40 (Way2API). Now a daily cap for them too: 20 a day (the user's choice, not 100).
-- Only GaadiPe's own numbers (is_internal) stay unlimited.
INSERT INTO app_settings (key, value) VALUES ('free_checks_per_day_subscriber', '20')
ON CONFLICT (key) DO UPDATE SET value = '20';
