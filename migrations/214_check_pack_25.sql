-- 214_check_pack_25.sql (user, 2026-10-26: "change 25 from 20 please"). The check pack (CHECKS5, migration 213)
-- costs ₹25 including GST for 5 checks, valid 30 days. The Terms sentence says the same (same version: the
-- price is shown before every payment and nothing renews).
UPDATE plans SET price_paise = 2500 WHERE code = 'CHECKS5';

UPDATE terms_and_conditions
   SET description = replace(description, '5 checks costs Rs.20 inclusive of GST', '5 checks costs Rs.25 inclusive of GST'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active
   AND description LIKE '%5 checks costs Rs.20 inclusive of GST%';
