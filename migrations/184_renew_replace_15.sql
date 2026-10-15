-- 184_renew_replace_15.sql (user, 2026-10-15: "renewal = 15 and replace also 15 — if I keep replace
-- at 11, everyone starts replacing vehicles"). Both now Rs.15 including GST: Rs.12.71 taxable +
-- Rs.2.29 GST at 18% (worked out on the invoice from the inclusive amount, pay/invoice.js).
-- The bot, the site and the checkout read the plans; the Terms and the Refund policy say the
-- amounts. Prices are shown before every payment and nothing renews by itself, so this is not
-- a new version to agree to (Terms 11).
UPDATE plans SET renewal_paise = 1500 WHERE code = 'REPORT19';
UPDATE plans SET price_paise = 1500, name = 'Replace vehicle — ₹15 incl. GST (monitoring moves to another vehicle)' WHERE code = 'REPLACE9';

UPDATE terms_and_conditions
   SET description = replace(description, 'costs Rs.11 for another 28 days', 'costs Rs.15 for another 28 days'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active AND description LIKE '%costs Rs.11 for another 28 days%';

UPDATE terms_and_conditions
   SET description = replace(description, 'for Rs.11, inclusive of GST (Rs.9.32 plus Rs.1.68 GST)', 'for Rs.15, inclusive of GST (Rs.12.71 plus Rs.2.29 GST)'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Replace Vehicle' AND is_active AND description LIKE '%for Rs.11, inclusive of GST (Rs.9.32 plus Rs.1.68 GST)%';

UPDATE refund_policy
   SET description = replace(description, 'The Rs.11 fee (inclusive of GST) to replace a vehicle', 'The Rs.15 fee (inclusive of GST) to replace a vehicle'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Replace Vehicle Fee' AND is_active AND description LIKE '%The Rs.11 fee (inclusive of GST) to replace a vehicle%';
