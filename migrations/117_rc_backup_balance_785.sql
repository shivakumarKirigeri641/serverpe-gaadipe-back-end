-- 117_rc_backup_balance_785.sql (user, 2026-10-05: "you can take: 785") — the
-- IDSPay balance to start tracking from: ₹785. Only if none was entered yet;
-- every call then takes off ₹3 + GST, and at ₹50 the paid-only guard returns.

UPDATE app_settings SET value = '78500', modified_at = now()
 WHERE key = 'rc_backup_balance_paise' AND coalesce(value, '') = '';
