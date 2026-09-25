-- 069_admin_roles.sql — Operations and Support roles (user, 2026-09-25,
-- command center phase 7).
--
-- src/admin/auth.js ROLES is where each role's capabilities live; this only
-- lets the table hold the two new names. Operations runs the service day to
-- day without the money; Support helps customers without changing anything.
-- Finance and Read-only (viewer) see customers' mobiles masked.

ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_role_check;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check
  CHECK (role IN ('owner', 'admin', 'operations', 'finance', 'support', 'viewer'));
