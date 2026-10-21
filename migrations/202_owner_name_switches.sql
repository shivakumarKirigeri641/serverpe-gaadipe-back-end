-- 202_owner_name_switches.sql (user, 2026-10-21: "put one configuration in the admin panel, toggling the
-- owner name before and after sign-in — off for before sign-in"). Two switches, both in Settings:
--   free_check_show_owner  before sign-in  false — the free check shows make, model, variant, fuel and the RTO
--   free_view_show_owner   after sign-in   true  — the signed-in free view shows the owner's name, masked
-- The Terms say it as it now is.
INSERT INTO app_settings (key, value) VALUES ('free_check_show_owner', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
INSERT INTO app_settings (key, value) VALUES ('free_view_show_owner', 'true')
  ON CONFLICT (key) DO NOTHING;

UPDATE terms_and_conditions SET modified_at = now(), description = replace(description,
  'The free check shows the vehicle''s make, model and variant, class and fuel, the registered owner''s name masked as in the Government''s records, and the RTO it is registered at. After signing in you also see how many of its documents and challans need attention;',
  'The free check shows the vehicle''s make, model and variant, class and fuel, and the RTO it is registered at. After signing in you also see the registered owner''s name, masked, and how many of its documents and challans need attention;')
 WHERE is_active AND title = 'Free Check Before Signing In';
