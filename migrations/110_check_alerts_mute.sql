-- 110_check_alerts_mute.sql — an owner can stop "your vehicle was checked"
-- alerts (the "Stop these alerts" button), and turn them on again by writing
-- ALERTS ON (src/owners/checkAlerts.js).

ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS check_alerts_off_at timestamptz;
