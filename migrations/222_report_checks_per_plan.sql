-- 222: CHECKS THAT COME WITH A REPORT, PER PLAN (user, 2026-10-29: "go ahead" - the ₹11 report's 5 bonus checks made it
-- cheaper than the ₹25 pack and could cost more in lookups than it earned). plans.check_credits on a report plan is how
-- many checks it adds (pay/packs.reportChecks): REPORT11 none, REPORT19 five. Editable in the admin plan editor.
UPDATE plans SET check_credits = 0 WHERE code = 'REPORT11';
UPDATE plans SET check_credits = 5 WHERE code = 'REPORT19';
