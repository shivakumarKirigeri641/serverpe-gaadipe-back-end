-- 086_fleet_payment_covered.sql — the vehicle numbers a fleet payment covered
-- (user, 2026-09-29): the lines of its GST invoice, frozen when it is issued,
-- so a lost PDF is rebuilt exactly even after vehicles change.

ALTER TABLE fleet_payments ADD COLUMN IF NOT EXISTS covered jsonb;
