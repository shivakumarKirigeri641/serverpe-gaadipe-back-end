-- 039_mail_backlog.sql — the admin emails start from now.
--
-- The notify job looks back up to two days for things to email about. On the
-- day it is switched on, that would send a burst of emails about sign-ins,
-- payments and feedback that happened before email existed. Everything already
-- in the database is marked as handled, so only what happens from here on is
-- emailed.

INSERT INTO admin_notifications (kind, ref, status, sent_to, sent_at)
SELECT 'sign_in', id::text, 'sent', '(before admin email)', now() FROM site_sign_ins WHERE event = 'signed_in'
ON CONFLICT (kind, ref) DO NOTHING;

INSERT INTO admin_notifications (kind, ref, status, sent_to, sent_at)
SELECT 'payment', id::text, 'sent', '(before admin email)', now() FROM payments WHERE status = 'paid'
ON CONFLICT (kind, ref) DO NOTHING;

INSERT INTO admin_notifications (kind, ref, status, sent_to, sent_at)
SELECT 'feedback', id::text, 'sent', '(before admin email)', now() FROM feedback
ON CONFLICT (kind, ref) DO NOTHING;

INSERT INTO admin_notifications (kind, ref, status, sent_to, sent_at)
SELECT 'contact', id::text, 'sent', '(before admin email)', now() FROM contact_messages
ON CONFLICT (kind, ref) DO NOTHING;
