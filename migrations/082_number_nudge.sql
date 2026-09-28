-- 082_number_nudge.sql — one reminder for people who agreed to the terms but
-- never sent a vehicle number (user, 2026-09-28). Kept apart from
-- terms_nudged_at so someone reminded about the terms can still be reminded
-- about the number — once each. src/jobs/nudge.js.

ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS number_nudged_at timestamptz;
