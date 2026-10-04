-- 111_template_names.sql — the two owner templates' names as submitted to Meta
-- (user, 2026-10-04). Changed only where the setting still holds the old
-- default, so a name set by hand on the panel is left alone.

UPDATE app_settings SET value = 'gp_owner_verification_update_v1', modified_at = now()
 WHERE key = 'owner_verify_template_name' AND value = 'owner_verification_update';
UPDATE app_settings SET value = 'gp_vehicle_check_alert_v1', modified_at = now()
 WHERE key = 'owner_check_alert_template_name' AND value = 'vehicle_check_alert';
