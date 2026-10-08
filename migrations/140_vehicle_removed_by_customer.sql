-- REMOVE FROM MY VEHICLES (user, 2026-10-08). The customer's bin button hides a
-- vehicle from their list; nothing is deleted. Checking the number again later
-- brings it back as a fresh entry (count 1, first checked that day).
--   hidden_at       when the customer removed it (NULL = in their list)
--   hidden_count    how many times they have removed it, for the admin
ALTER TABLE user_vehicles ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
ALTER TABLE user_vehicles ADD COLUMN IF NOT EXISTS hidden_count integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_user_vehicles_visible ON user_vehicles (user_id) WHERE hidden_at IS NULL;
