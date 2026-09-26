-- 076_whatsapp_nudges.sql — one gentle reminder, free, inside WhatsApp's
-- 24-hour window (user, 2026-09-26).
--
-- Half the people who say hi stop at the terms screen, and half the payment
-- links are never opened. src/jobs/nudge.js sends ONE reminder to each: after
-- an hour, only while the free window is open, never after STOP, never at
-- night. These columns are how "once" is kept: a claimed row is never
-- reminded again.

ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS terms_nudged_at timestamptz;
ALTER TABLE payments          ADD COLUMN IF NOT EXISTS nudged_at       timestamptz;

INSERT INTO app_settings (key, value) VALUES
  ('nudge_enabled',        'true'),
  ('nudge_after_minutes',  '60'),
  -- No reminder between these hours (IST). One due at night waits for the
  -- morning if the 24-hour window is still open, otherwise it is not sent.
  ('nudge_quiet_from_ist', '21'),
  ('nudge_quiet_to_ist',   '8')
ON CONFLICT (key) DO NOTHING;
