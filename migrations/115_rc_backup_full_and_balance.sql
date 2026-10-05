-- 115_rc_backup_full_and_balance.sql (user, 2026-10-05: "for now allow the
-- backup for basic details, store full in my cache and show masked; once the
-- IDSPay balance is below 50, come back with this guard").
--
--   rc_backup_paid_only          false — free checks may use the backup again
--   rc_backup_store_full         true  — IDSPay's answer kept whole in the cache;
--                                        customers still only see it masked
--   rc_backup_balance_paise      the IDSPay balance, entered by the admin
--                                (blank = not tracked); each call takes off
--                                ₹3 + GST, IDSPay's own figure wins if it sends one
--   rc_backup_low_balance_paise  at or below this (₹50) the guard comes back:
--                                rc_backup_paid_only is set true and the admin told

INSERT INTO app_settings (key, value) VALUES
  ('rc_backup_store_full', 'true'),
  ('rc_backup_balance_paise', ''),
  ('rc_backup_low_balance_paise', '5000')
ON CONFLICT (key) DO NOTHING;

UPDATE app_settings SET value = 'false', modified_at = now() WHERE key = 'rc_backup_paid_only';
