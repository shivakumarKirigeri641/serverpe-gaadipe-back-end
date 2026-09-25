-- 071_technical_role.sql — the Technical role (user, 2026-09-25, operations
-- module). What each role may do lives in src/admin/auth.js ROLES; this only
-- lets the table hold the new name.

ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_role_check;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check
  CHECK (role IN ('owner', 'admin', 'operations', 'finance', 'support', 'technical', 'viewer'));
