-- 185_renewal_back_to_11.sql (user, 2026-10-15: "oh ok, keep it 11 only then" — the ads say
-- "Renew ₹11"). Renewal back to Rs.11 including GST; replace vehicle stays Rs.15 (migration 184:
-- "if I keep replace at 11, everyone starts replacing vehicles").
UPDATE plans SET renewal_paise = 1100 WHERE code = 'REPORT19';

UPDATE terms_and_conditions
   SET description = replace(description, 'costs Rs.15 for another 28 days', 'costs Rs.11 for another 28 days'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active AND description LIKE '%costs Rs.15 for another 28 days%';
