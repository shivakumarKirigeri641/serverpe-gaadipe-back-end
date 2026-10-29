-- 223: NO MORE CHECK PACKS FOR SALE (user, 2026-10-29: "keep 11 & 19 ... very first check per mobile number free"; sales
-- 26-29 Oct: ₹11 ×3, ₹19 ×1, ₹25 pack ×1, ₹49 / ₹99 ×0). The first vehicle check per mobile stays free; any other new
-- vehicle is its full report (₹11 once, ₹19 with alerts). Those who bought a pack keep using its checks until they are
-- used or expire (check_credits untouched). No report adds checks any more (₹11 none since migration 222, ₹19 now too).
-- A pack can be switched back on in admin Plans; the bot and the site offer it again at once.
UPDATE plans SET is_active = false WHERE kind = 'checks';
UPDATE plans SET check_credits = 0 WHERE code = 'REPORT19';
