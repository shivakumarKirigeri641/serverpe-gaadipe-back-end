-- 150_free_check_first.sql (user, 2026-10-10: "for a first-time user, no quick
-- options — reply them to type in the vehicle number; showing sign-in feels
-- awkward"). The chat opens with "type a vehicle number" for a visitor: the free
-- check before sign-in must be on, never the mobile-number box first.
INSERT INTO app_settings (key, value) VALUES ('check_sign_in_required', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
