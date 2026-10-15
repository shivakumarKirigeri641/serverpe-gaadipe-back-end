-- 183_six_checks_a_day.sql (user, 2026-10-15: "change 5 to 6"). Signed-in and WhatsApp customers
-- may check 6 vehicles a day (was 5 since migration 182). The site and the bot read the setting;
-- the Terms say the number.
INSERT INTO app_settings (key, value) VALUES ('free_checks_per_day', '6'), ('free_checks_per_day_trial', '6')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

UPDATE terms_and_conditions
   SET description = replace(description, 'up to 5 vehicles a day and 30 a month', 'up to 6 vehicles a day and 30 a month'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active AND description LIKE '%up to 5 vehicles a day and 30 a month%';
