-- 174_notify_vehicle_changes.sql (user, 2026-10-14: "when a user removes or replaces, send
-- those details to my mail"). jobs/notify.js vehicleChanges: one email per vehicle removed
-- from My vehicles (website or WhatsApp) and per vehicle replaced (after the ₹11 is paid).
INSERT INTO app_settings (key, value) VALUES ('notify_vehicle_changes', 'true')
ON CONFLICT (key) DO NOTHING;
