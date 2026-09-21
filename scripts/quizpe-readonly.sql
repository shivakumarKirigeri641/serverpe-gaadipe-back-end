-- scripts/quizpe-readonly.sql — the read-only login GaadiPe uses to check QuizPe
-- referrals (user, 2026-09-21). Run ONCE on the server, against QuizPe's database:
--
--   sudo -u postgres psql -d <quizpe_database> -v ro_password='<a long random password>' \
--        -f /var/www/serverpe-gaadipe-back-end/scripts/quizpe-readonly.sql
--
-- Then put the same values in GaadiPe's .env_prod:
--   QUIZPE_RO_HOST=localhost   QUIZPE_RO_PORT=5432
--   QUIZPE_RO_DATABASE=<quizpe_database>   QUIZPE_RO_USER=gaadipe_ro   QUIZPE_RO_PASSWORD=<same password>
--
-- WHAT IT CAN DO: read these columns, and nothing else — no other column, no
-- other table, no writes (every session is read-only too). QuizPe's own code and
-- data are untouched; running this again is safe.

SELECT 'CREATE ROLE gaadipe_ro LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gaadipe_ro') \gexec
ALTER ROLE gaadipe_ro PASSWORD :'ro_password';
ALTER ROLE gaadipe_ro SET default_transaction_read_only = on;
ALTER ROLE gaadipe_ro SET statement_timeout = '10s';
ALTER ROLE gaadipe_ro CONNECTION LIMIT 3;

SELECT format('GRANT CONNECT ON DATABASE %I TO gaadipe_ro', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO gaadipe_ro;

-- A parent: who (the number), and when they joined.
GRANT SELECT (id, parent_mobile_number, created_at) ON parents TO gaadipe_ro;
-- Which subscription is theirs.
GRANT SELECT (id, parent_id) ON parents_quizpe_subscriptions TO gaadipe_ro;
-- A paid subscription has an invoice pointing at its payment (a trial has none).
GRANT SELECT (subscription_id, payment_id, created_at) ON invoices TO gaadipe_ro;
-- The payment: captured, and how much.
GRANT SELECT (id, payment_id, amount, captured) ON payments TO gaadipe_ro;
