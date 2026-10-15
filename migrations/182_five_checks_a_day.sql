-- 182_five_checks_a_day.sql (user, 2026-10-15: "instead of 10, can we reduce to 5?"). Signed-in
-- customers (WhatsApp, and the website after sign-in) may check 5 vehicles a day instead of 10
-- (util/quota.js). The month stays 30, each report bought still adds 5 that month, and the
-- free look before signing in on the website stays 2 a day. The site and the bot read the
-- number from this setting; the Terms say it. Terms 7 already allows free checks to be limited
-- without notice, so this is not a new version to agree to.
INSERT INTO app_settings (key, value) VALUES ('free_checks_per_day', '5'), ('free_checks_per_day_trial', '5')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

UPDATE terms_and_conditions
   SET description = replace(description, 'up to 10 vehicles a day and 30 a month', 'up to 5 vehicles a day and 30 a month'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active AND description LIKE '%up to 10 vehicles a day and 30 a month%';
