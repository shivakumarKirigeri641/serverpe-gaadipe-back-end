-- 058_renewal_days_parameter.sql — the window becomes a parameter (user, 2026-09-23).
--
-- "28 days" was written into the renewal template, which meant changing the
-- monitoring window would need a new template raised with Meta and approved
-- before a single message could go out. It is now {{4}}, filled from
-- plans.duration_days — so the window is changed in Prices & settings, and the
-- message follows on the next send.
--
-- WHY THE NUMBERING MOVED. Meta numbers variables in the order they appear in
-- the body, so the days figure — which comes before the price in the sentence —
-- has to be {{4}}, and the price becomes {{5}}. The sending code changes with
-- it: [name, vehicle, ends_on, days, price].
--
-- AND WHY THE BODY IS LONGER. Meta refused the monitoring template for having
-- too many variables for its length, and a fifth variable here would have
-- pushed this one the same way — from 49 fixed characters per variable to 38.
-- The extra sentence is true and useful, and it buys the room.

UPDATE wa_templates
   SET body_text = E'Hi {{1}},\n\nMonitoring for your vehicle {{2}} ends on {{3}}.\n\nRenew for another {{4}} days for {{5}} — we keep checking for new challans, and warn you before insurance, PUC, road tax or fitness expires.\n\nNothing renews automatically, and nothing has been charged.\n\nRegards,\nGaadiPe',
       variables = '["first_name","last_vehicle","ends_on","days","price"]'::jsonb,
       approval_status = 'PENDING',
       modified_at = now()
 WHERE template_name = 'gp_renewal_en_v1' AND language = 'en';
