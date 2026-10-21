-- 201_owner_before_sign_in_again.sql (user, 2026-10-21: "leave it, revert it — CarInfo already shows it,
-- but people don't know"). Undoes 200: the free check before sign-in shows the owner's name, masked, again;
-- the Terms say so as before.
INSERT INTO app_settings (key, value) VALUES ('free_check_show_owner', 'true')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

UPDATE terms_and_conditions SET modified_at = now(), description = replace(description,
  'The free check shows the vehicle''s make, model and variant, class and fuel, and the RTO it is registered at. After signing in you also see the registered owner''s name, masked, and how many of its documents and challans need attention;',
  'The free check shows the vehicle''s make, model and variant, class and fuel, the registered owner''s name masked as in the Government''s records, and the RTO it is registered at. After signing in you also see how many of its documents and challans need attention;')
 WHERE is_active AND title = 'Free Check Before Signing In';
