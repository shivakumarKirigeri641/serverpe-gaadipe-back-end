-- 216_check_pack_99_30_days.sql (user, 2026-10-26: "for 99 you put 90 days, why? make it 30 days"). The ₹99 pack
-- (CHECKS25, 25 checks) is valid 30 days, not 90. The Terms sentence says the same (same version).
UPDATE plans SET duration_days = 30, name = 'Vehicle checks — 25 checks, valid 30 days' WHERE code = 'CHECKS25';

UPDATE terms_and_conditions
   SET description = replace(description, '25 checks for Rs.99 (valid 90 days)', '25 checks for Rs.99 (valid 30 days)'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active
   AND description LIKE '%25 checks for Rs.99 (valid 90 days)%';
