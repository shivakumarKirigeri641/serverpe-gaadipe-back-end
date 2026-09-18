-- 021_rc_verification.sql — proving you hold the RC.
--
-- GaadiPe deliberately never displays the chassis number. That decision, taken
-- for privacy, is what makes this possible: a number we have never shown is a
-- number only someone holding the RC — or standing at the vehicle — can produce.
--
-- ULIP masks the END of the chassis (YV3T7U52XP821391*****), so the part we
-- hold is the PREFIX. The challenge is therefore the first five characters, not
-- the last four.
--
-- WHAT IT PROVES, precisely: possession of the RC or physical access to the
-- vehicle. Not legal ownership — a buyer inspecting a car can read the chassis
-- plate. The badge says "RC verified" for exactly that reason; claiming
-- "verified owner" would be claiming something we did not check.
--
-- Why it is worth having at all: today there is no way to tell "this is my car"
-- from "I typed a plate". Every future feature that acts on an owner's behalf —
-- telling them their RC was transferred out, letting them hand a report to a
-- buyer, moving a vehicle to a new mobile number — needs this signal to exist.
--
-- Attempts are counted and locked, because a five-character challenge that can
-- be guessed for free is not a challenge.

BEGIN;

CREATE TABLE IF NOT EXISTS vehicle_verifications (
  id            bigserial PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id    bigint      NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  -- 'chassis_prefix' today; the column exists so a future method (an OTP to the
  -- number registered at the RTO, say) does not need a new table.
  method        text        NOT NULL DEFAULT 'chassis_prefix',
  is_verified   boolean     NOT NULL DEFAULT false,
  attempts      integer     NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  modified_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_verifications_unique UNIQUE (user_id, vehicle_id)
);

CREATE INDEX IF NOT EXISTS idx_verifications_verified
    ON vehicle_verifications (user_id) WHERE is_verified;

INSERT INTO app_settings (key, value) VALUES
  ('verify_prefix_length',        '5'),
  ('verify_max_attempts',         '3'),
  ('verify_lock_minutes',         '1440'),
  -- A verified vehicle earns a higher daily check allowance: they have proved
  -- who they are, which is exactly the thing the limit exists to guess at.
  ('free_checks_per_day_verified', '25')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
