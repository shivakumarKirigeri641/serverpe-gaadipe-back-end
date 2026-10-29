-- 224: THE CHECK PACKS BACK ON SALE (user, 2026-10-29: "then revert them" - the running ad image gp-wa-4 shows the
-- ₹25 / ₹49 / ₹99 packs). Undoes migration 223: the three packs on, the ₹19 report adds 5 checks again. The ₹11 report
-- stays without checks (migration 222). The code reads the plans, so the pack texts and buttons return at once.
UPDATE plans SET is_active = true WHERE code IN ('CHECKS5', 'CHECKS12', 'CHECKS25');
UPDATE plans SET check_credits = 5 WHERE code = 'REPORT19';
