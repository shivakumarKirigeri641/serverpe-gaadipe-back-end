-- An archived account's mobile (2026-10-07).
--
-- Deactivating archives the account and frees its number for a fresh one
-- (migration 130). users.mobile must be ten digits, so the archived value was
-- refused; and a value that still ended in the number ("a<id>-<mobile>") would be
-- matched by every query that compares the last ten digits — the old account and
-- the new one together. An archived account's mobile is now "archived-<id>", which
-- matches no number; archived_mobile keeps the real one.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_mobile_check;
ALTER TABLE users ADD CONSTRAINT users_mobile_check
  CHECK (mobile ~ '^[0-9]{10}$' OR (archived_at IS NOT NULL AND mobile ~ '^archived-[0-9]+$'));
