-- 210_user_wa_numbers.sql (user, 2026-10-23: "mark all new users arriving on this new number, so it is easier
-- to SMS them that WhatsApp is disabled and to continue on the web"). Which of GaadiPe's WhatsApp business
-- numbers each customer wrote to, with when they first did — one row per customer per number, never lost when
-- the number changes. users.wa_business_number is the latest one, for the admin at a glance.
CREATE TABLE IF NOT EXISTS user_wa_numbers (
  user_id          bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_number  text        NOT NULL,                 -- e.g. 917996083415
  first_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, business_number)
);
CREATE INDEX IF NOT EXISTS user_wa_numbers_number ON user_wa_numbers (business_number, first_at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_business_number text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_business_number_at timestamptz;

-- Everyone who has already written to the new number (+91 79960 83415, live from 22 Oct 2026, 16:18 UTC),
-- from the messages on record.
INSERT INTO user_wa_numbers (user_id, business_number, first_at)
SELECT u.id, '917996083415', min(m.created_at)
  FROM whatsapp_messages m
  JOIN users u ON right(regexp_replace(u.mobile, '\D', '', 'g'), 10) = right(regexp_replace(m.mobile, '\D', '', 'g'), 10)
 WHERE m.direction = 'in' AND m.created_at >= '2026-10-22T16:18:00Z'
 GROUP BY u.id
ON CONFLICT DO NOTHING;

UPDATE users u SET wa_business_number = x.business_number, wa_business_number_at = x.first_at
  FROM (SELECT DISTINCT ON (user_id) user_id, business_number, first_at FROM user_wa_numbers ORDER BY user_id, first_at DESC) x
 WHERE u.id = x.user_id AND u.wa_business_number IS NULL;
