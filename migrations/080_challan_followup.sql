-- 080_challan_followup.sql — a paid report issued while the e-Challan service
-- was not answering is completed later (user, 2026-09-27).
--
-- src/jobs/challanFollowup.js retries the challan check every 30 minutes for
-- up to a day. When it answers, the stored report and its PDF are updated and
-- the customer is told the challan details (free message in the 24-hour
-- window, else the approved monitoring template).

ALTER TABLE vehicle_reports ADD COLUMN IF NOT EXISTS challan_tries        int NOT NULL DEFAULT 0;
ALTER TABLE vehicle_reports ADD COLUMN IF NOT EXISTS challan_next_try_at  timestamptz;
ALTER TABLE vehicle_reports ADD COLUMN IF NOT EXISTS challan_completed_at timestamptz;

INSERT INTO app_settings (key, value) VALUES
  ('challan_followup_enabled',       'true'),
  ('challan_followup_every_minutes', '30'),
  ('challan_followup_max_tries',     '48')     -- 48 × 30 min = a day
ON CONFLICT (key) DO NOTHING;
