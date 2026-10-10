-- 157_offers_and_newsletters.sql (user, 2026-10-10: "instead of offer/promotion, include the
-- word offers/newsletters for user consent"). The opt-in the chat and the Profile show is
-- now "offers and newsletters" (site/auth.js PROMO_CONSENT), and the promotional SMS
-- templates say "offers & news" — Terms 22 is worded the same way.

UPDATE terms_and_conditions
   SET description = replace(description,
         'PROMOTIONAL messages — tips, new features and offers — are sent only if you opt in,',
         'PROMOTIONAL messages — offers and newsletters (vehicle tips, new features and offers) — are sent only if you opt in,'),
       version = '5.1', effective_from = CURRENT_DATE, modified_at = now()
 WHERE id = 22
   AND description LIKE '%PROMOTIONAL messages — tips, new features and offers — are sent only if you opt in,%';
