-- 172_replace_11.sql (user, 2026-10-14: "replace vehicle is 9 + GST, about 10.62 — make it
-- 11, rounded, inclusive of GST, with the breakup"). The fee is now Rs.11 all-inclusive:
-- Rs.9.32 taxable + Rs.1.68 GST at 18% (CGST Rs.0.84 + SGST Rs.0.84, or IGST Rs.1.68),
-- worked out on the invoice from the inclusive amount (pay/invoice.js), as for Rs.19 and Rs.11.
UPDATE plans
   SET price_paise = 1100, name = 'Replace vehicle — ₹11 incl. GST (monitoring moves to another vehicle)'
 WHERE code = 'REPLACE9';

-- The Terms and the Refund policy say the new amount (part of policy version 5.3, 171).
UPDATE terms_and_conditions
   SET description = replace(description, 'for Rs.9 plus GST (Rs.10.62 in all)',
         'for Rs.11, inclusive of GST (Rs.9.32 plus Rs.1.68 GST)'),
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Replace Vehicle' AND is_active AND description LIKE '%for Rs.9 plus GST (Rs.10.62 in all)%';

UPDATE refund_policy
   SET description = replace(description, 'The Rs.9 plus GST fee to replace a vehicle',
         'The Rs.11 fee (inclusive of GST) to replace a vehicle'),
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Replace Vehicle Fee' AND is_active AND description LIKE '%The Rs.9 plus GST fee to replace a vehicle%';
