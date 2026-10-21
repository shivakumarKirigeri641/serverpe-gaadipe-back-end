-- 200_owner_after_sign_in.sql (user, 2026-10-21: "better stop showing the owner name — let them sign in and
-- see"). The free check before sign-in shows make, model, variant, class, fuel and the RTO; the owner's name
-- (masked) is shown after signing in with the mobile and an SMS code (site/vehicleView.js). The Terms say so.
INSERT INTO app_settings (key, value) VALUES ('free_check_show_owner', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

UPDATE terms_and_conditions SET modified_at = now(), description = replace(description,
  'The free check shows the vehicle''s make, model and variant, class and fuel, the registered owner''s name masked as in the Government''s records, and the RTO it is registered at. After signing in you also see how many of its documents and challans need attention;',
  'The free check shows the vehicle''s make, model and variant, class and fuel, and the RTO it is registered at. After signing in you also see the registered owner''s name, masked, and how many of its documents and challans need attention;')
 WHERE is_active AND title = 'Free Check Before Signing In';
