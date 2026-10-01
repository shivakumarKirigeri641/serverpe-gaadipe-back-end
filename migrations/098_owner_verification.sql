-- 098_owner_verification.sql — what owner verification (src/owners/verify.js)
-- needs beyond the claims table of 097.
--
--   hidden_at   a verified owner chose to hide the vehicle from other people's
--               checks, on WhatsApp and the website (they still see it)
--   counted     false for a claim that does not count towards the lock: one
--               left unfinished, or one an admin unlocked

ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS counted boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS vehicle_owner_claims_hidden
  ON vehicle_owner_claims (reg_no) WHERE status = 'verified' AND hidden_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS vehicle_owner_claims_status ON vehicle_owner_claims (status, created_at DESC);

-- Many different numbers failing on one vehicle in a day is someone guessing:
-- the vehicle stops taking claims for the rest of the day.
INSERT INTO app_settings (key, value) VALUES
  ('owner_verification_vehicle_daily_failures', '6'),
  ('owner_verification_mobile_daily_failures',  '6')
ON CONFLICT (key) DO NOTHING;
