-- Sign in for every vehicle check (user, 2026-10-08). The chat's free checks
-- without signing in stop; switch it off in Configuration to bring them back.
INSERT INTO app_settings (key, value) VALUES ('check_sign_in_required', 'true')
ON CONFLICT (key) DO UPDATE SET value = 'true', modified_at = now();
