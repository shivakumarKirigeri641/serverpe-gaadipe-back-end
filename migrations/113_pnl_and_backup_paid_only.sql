-- 113_pnl_and_backup_paid_only.sql (user, 2026-10-05)
--
-- 1. PROFIT & LOSS on the Profitability page (src/admin/profitability.js):
--      pnl_ads_daily_paise       GaadiPe ad spend for a day not entered on the
--                                Ad spend page (₹150/day); 0 = count only entries
--      pnl_fixed_monthly_paise   server, domain, email and other fixed costs a
--                                month, spread over the days of the period
--
-- 2. THE RC BACKUP ONLY FOR PAYING CUSTOMERS (src/whatsapp/flow.js, routes):
--      rc_backup_paid_only       true: a free check never uses the paid backup —
--                                when ULIP is down the customer goes on the
--                                waiting list and may buy the full report at once,
--                                and THAT report is fetched from the backup.
--                                false: the backup answers free checks too.

INSERT INTO app_settings (key, value) VALUES
  ('pnl_ads_daily_paise', '15000'),
  ('pnl_fixed_monthly_paise', '0'),
  ('rc_backup_paid_only', 'true')
ON CONFLICT (key) DO NOTHING;
