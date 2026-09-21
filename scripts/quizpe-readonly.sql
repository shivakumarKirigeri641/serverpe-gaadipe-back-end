-- scripts/quizpe-readonly.sql — GaadiPe's read-only window into QuizPe, for the
-- referral link (user, 2026-09-21). Run ONCE on the server, against QuizPe's
-- database, as the postgres superuser:
--
--   sudo -u postgres psql -d <quizpe_database> -v ro_password='<a long random password>' \
--        -f /var/www/serverpe-gaadipe-back-end/scripts/quizpe-readonly.sql
--
-- Then put the same values in GaadiPe's .env_prod (QUIZPE_RO_*).
--
-- WHAT GAADIPE CAN SEE — two views, nothing else:
--   gaadipe_ref_messages      incoming WhatsApp messages that carry a GaadiPe
--                             referral code: the sender's number, the code, the time
--   gaadipe_premium_payments  captured QuizPe payments — ONLY for numbers that
--                             sent a GaadiPe code: amount, when, and the plan's dates
-- No other message, chat, child, quiz or table; no writes (every session is
-- read-only). QuizPe's code and data are not changed; running this again is safe.

SELECT 'CREATE ROLE gaadipe_ro LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gaadipe_ro') \gexec
ALTER ROLE gaadipe_ro PASSWORD :'ro_password';
ALTER ROLE gaadipe_ro SET default_transaction_read_only = on;
ALTER ROLE gaadipe_ro SET statement_timeout = '10s';
ALTER ROLE gaadipe_ro CONNECTION LIMIT 3;

SELECT format('GRANT CONNECT ON DATABASE %I TO gaadipe_ro', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO gaadipe_ro;

-- Least access: nothing on QuizPe's tables themselves (an earlier version of
-- this script granted a few columns; they are taken back here).
REVOKE ALL ON parents, parents_quizpe_subscriptions, invoices, payments FROM gaadipe_ro;
REVOKE ALL ON whatsapp_messages FROM gaadipe_ro;

CREATE OR REPLACE VIEW gaadipe_ref_messages AS
SELECT right(regexp_replace(m.mobile_number, '[^0-9]', '', 'g'), 10)            AS mobile,
       upper((regexp_match(m.body, 'GP-([A-Za-z0-9]{6,10})'))[1])                AS code,
       m.created_at
  FROM whatsapp_messages m
 WHERE m.direction = 'inbound'
   AND m.body ~ 'GP-[A-Za-z0-9]{6,10}';

CREATE OR REPLACE VIEW gaadipe_premium_payments AS
SELECT right(regexp_replace(p.parent_mobile_number, '[^0-9]', '', 'g'), 10)      AS mobile,
       pay.payment_id, pay.amount, i.created_at AS paid_at,
       s.plan_start_date, s.plan_end_date
  FROM parents p
  JOIN parents_quizpe_subscriptions s ON s.parent_id = p.id
  JOIN invoices i ON i.subscription_id = s.id          -- a trial has no invoice
  JOIN payments pay ON pay.id = i.payment_id
 WHERE pay.captured = true
   AND right(regexp_replace(p.parent_mobile_number, '[^0-9]', '', 'g'), 10)
       IN (SELECT mobile FROM gaadipe_ref_messages);

GRANT SELECT ON gaadipe_ref_messages, gaadipe_premium_payments TO gaadipe_ro;
