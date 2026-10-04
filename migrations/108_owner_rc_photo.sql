-- 108_owner_rc_photo.sql — owner verification by RC photo (user, 2026-10-04,
-- src/owners/photo.js). The customer sends a photo (or the DigiLocker PDF) of
-- their RC on WhatsApp; the admin compares it with the Government record and
-- approves or rejects it; the photo is deleted the moment that is decided.
--
--   status 'review'    photo received, waiting for the admin
--   photo_path         the encrypted photo while it waits (never after)
--   photo_deleted_at   when it was deleted — the proof the promise was kept
--   reward             what the owner gets on approval: 'report' (free full
--                      report), 'extend' (a running paid report extended),
--                      'none' (offer off, used up, or rejected)
--   notice             the customer still has to be told the decision:
--                      'pending' (their WhatsApp window was shut), 'sent'
--   reward_status      'pending' until the reward is given, then 'given'
--   reject_reason      shown to the customer, so they can send a better photo

ALTER TABLE vehicle_owner_claims DROP CONSTRAINT IF EXISTS vehicle_owner_claims_status_check;
ALTER TABLE vehicle_owner_claims ADD CONSTRAINT vehicle_owner_claims_status_check
  CHECK (status IN ('pending', 'review', 'verified', 'failed', 'locked', 'rejected', 'revoked'));

ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS photo_path text;
ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS photo_mime text;
ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS photo_at timestamptz;
ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS photo_deleted_at timestamptz;
ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS reward text;
ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS reward_status text;
ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS reward_at timestamptz;
ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS notice text;
ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS reject_reason text;
ALTER TABLE vehicle_owner_claims ADD COLUMN IF NOT EXISTS decided_at timestamptz;

CREATE INDEX IF NOT EXISTS vehicle_owner_claims_review ON vehicle_owner_claims (photo_at) WHERE status = 'review';
CREATE INDEX IF NOT EXISTS vehicle_owner_claims_notice ON vehicle_owner_claims (mobile)
  WHERE notice = 'pending' OR reward_status = 'pending';

-- The report shows the "Owner verified" seal when it was issued to the
-- vehicle's verified owner (pdf/vehicleReport.js).
ALTER TABLE vehicle_reports ADD COLUMN IF NOT EXISTS owner_verified_at timestamptz;

INSERT INTO app_settings (key, value) VALUES
  -- 'photo' (RC photo, checked by the admin) or 'details' (chassis + policy typed in)
  ('owner_verification_method', 'photo'),
  -- The offer: a free full report for a newly verified vehicle…
  ('owner_verify_reward_on', 'true'),
  -- …at most this many free reports per customer (other vehicles get the badge only)
  ('owner_verify_free_reports_per_customer', '1'),
  -- …and the offer ends after this many free reports in all (0 = no limit)
  ('owner_verify_free_reports_total', '100'),
  -- A vehicle with a paid report still running gets this many days added instead
  ('owner_verify_extend_days', '28'),
  -- Photo submissions one number may make in 24 hours
  ('owner_verify_photos_per_day', '5'),
  -- The approved WhatsApp template for telling a customer the decision when
  -- their 24-hour window has shut. Off until the template is approved.
  ('owner_verify_template_on', 'false'),
  ('owner_verify_template_name', 'gp_owner_verification_update_v1'),
  ('owner_verify_template_language', 'en')
ON CONFLICT (key) DO NOTHING;
