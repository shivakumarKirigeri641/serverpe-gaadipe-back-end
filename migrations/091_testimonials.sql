-- 091_testimonials.sql — approved feedback becomes a testimonial on the
-- marketing site (user, 2026-09-30). The admin approves a note from the
-- website feedback link (whose form says the first name, rating and message
-- may be shown), may tidy the text and the name shown, and can take it down
-- again. Only approved rows are ever sent to the website.

ALTER TABLE feedback ADD COLUMN IF NOT EXISTS approved_at  timestamptz;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS approved_by  bigint;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS public_name  text;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS public_text  text;

CREATE INDEX IF NOT EXISTS idx_feedback_approved ON feedback (approved_at DESC) WHERE approved_at IS NOT NULL;
