-- Referral rewards hidden (user, 2026-10-08: "currently hide"): no free report
-- and no reduced-price report is offered or spent; everyone pays the plan price.
-- Rewards already earned are kept. Switch on in Configuration to bring them back.
INSERT INTO app_settings (key, value) VALUES ('referral_rewards_enabled', 'false')
ON CONFLICT (key) DO UPDATE SET value = 'false', modified_at = now();
