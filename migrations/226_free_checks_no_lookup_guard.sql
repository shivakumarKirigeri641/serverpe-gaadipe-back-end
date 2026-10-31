-- 226: NO GUARD WITHIN THE FREE CHECKS (user, 2026-10-31: "5 free checks means no concept of guard, let them check
-- for any vehicle, anyway 2.4 goes and consider that as investment"). Every free check - already limited to 5 new
-- vehicles a day (migration 225) - gets the paid RC lookup: the paid-lookup caps are skipped
-- (vehicle/rcBackup.freeOpts) and the paid backup is open to free checks. A vehicle GaadiPe already holds an RC
-- for is still shown from the saved record (no second purchase). The low-balance safety (rcBackup) still turns
-- rc_backup_paid_only back on by itself when a provider wallet runs low, so paying customers are always served.
INSERT INTO app_settings (key, value) VALUES
  ('free_check_lookup_guard', 'false'),
  ('rc_backup_paid_only', 'false')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
