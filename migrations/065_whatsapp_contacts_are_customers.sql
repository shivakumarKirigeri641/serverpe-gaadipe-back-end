-- 065_whatsapp_contacts_are_customers.sql — everyone who has written on
-- WhatsApp is a customer the admin panel can see (user, 2026-09-25).
--
-- A users row used to appear only when someone checked a vehicle or paid, so
-- a person who said Hi and stopped existed only in whatsapp_sessions — and the
-- Customers screen, the Home counts and the daily email, all built on users,
-- could not see them. From now on the webhook creates the row at the first
-- message (routes/whatsapp.js); this does the same for everyone who wrote
-- before, dated from their first message so "joined" stays true.

INSERT INTO users (mobile, wa_profile_name, wa_id, signup_channel, created_at, last_seen_at)
SELECT s.mobile, s.profile_name, s.wa_id, 'whatsapp', s.created_at,
       coalesce(s.last_inbound_at, s.created_at)
  FROM whatsapp_sessions s
 WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.mobile = s.mobile)
ON CONFLICT (mobile) DO NOTHING;

-- And tie each chat to its customer, as the webhook now does.
UPDATE whatsapp_sessions s
   SET user_id = u.id
  FROM users u
 WHERE u.mobile = s.mobile AND s.user_id IS DISTINCT FROM u.id;
