-- 193_renewal_15.sql (user, 2026-10-20: "for renewal, change to 15/-"). Renewal Rs.15 including
-- GST (Rs.12.71 taxable + Rs.2.29 GST at 18%, worked out on the invoice from the inclusive
-- amount, pay/invoice.js), the same as replace vehicle (184). Undoes 185, which went back to
-- Rs.11 only because the ads said "Renew ₹11"; the new web ads say ₹15. The bot, the site and
-- the checkout read the plan; the Terms say the amount. Prices are shown before every payment
-- and nothing renews by itself, so this is not a new version to agree to (as in 184).
UPDATE plans SET renewal_paise = 1500 WHERE code = 'REPORT19';

UPDATE terms_and_conditions
   SET description = replace(description, 'costs Rs.11 for another 28 days', 'costs Rs.15 for another 28 days'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active AND description LIKE '%costs Rs.11 for another 28 days%';
