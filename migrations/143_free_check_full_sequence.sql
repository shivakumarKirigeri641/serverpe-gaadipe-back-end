-- 143_free_check_full_sequence.sql (user, 2026-10-08: "allow the sequence of checks
-- before sign-in as well — we store RC, challans and FASTag anyway: ULIP, down?
-- eChallan.app, not available? IDSPay").
-- The free check before sign-in now runs the full lookup and stores it; the visitor
-- still sees only make, model name and fuel. The paid RC backup (IDSPay) is capped
-- for free checks at this many calls a day; past it, free checks stop at eChallan.app.
INSERT INTO app_settings (key, value) VALUES ('free_check_backup_per_day', '30')
ON CONFLICT (key) DO NOTHING;
