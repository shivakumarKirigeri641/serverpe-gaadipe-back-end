-- 090_feedback_rating.sql — feedback from the website link (user, 2026-09-30).
-- gaadipe.in/feedback is sent in broadcasts: a star rating and a message, no
-- sign-in. The number is optional there, so mobile may be empty; channel says
-- where it came from ('whatsapp', 'web', 'web:broadcast', …).

ALTER TABLE feedback ADD COLUMN IF NOT EXISTS rating  smallint CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS name    text;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE feedback ALTER COLUMN mobile DROP NOT NULL;
