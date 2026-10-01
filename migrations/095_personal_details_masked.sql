-- 095_personal_details_masked.sql — "personal details are masked" instead of
-- "not shown" (user, 2026-10-01), as on the Government's Parivahan portal:
--   · the owner's name shown masked, as ULIP gives it (reverses 089's 'hidden')
--   · chassis and engine numbers shown with only their first character
--   · Terms clause "Information We Deliberately Do Not Show" reworded to match.
-- The clause keeps its version on purpose (user): the change is about how
-- other people's details are displayed, not about anything a customer agreed
-- to for themselves, so nobody is asked to agree again.

INSERT INTO app_settings (key, value) VALUES ('owner_name_display', 'masked')
ON CONFLICT (key) DO UPDATE SET value = 'masked';

UPDATE terms_and_conditions
   SET title = 'Personal Details Are Masked',
       description = 'Personal details are masked, as on the Government''s Parivahan portal. GaadiPe shows the registered owner''s name only in the masked form the Government records give it (for example R********I), and the chassis and engine numbers with only their first character, the rest hidden. Policy and certificate numbers are shown with only their last four characters. We never show an owner''s address or contact number, and we do not show FASTag toll-crossing history; only the tag status and balance are shown. We cannot verify who owns a vehicle from a registration number alone, so nothing we show identifies or tracks its owner. Document validity and challan information are shown because they are what the service exists to report.',
       modified_at = now()
 WHERE title = 'Information We Deliberately Do Not Show';
