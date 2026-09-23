-- 061_starthere_approved.sql — Meta approved the first one (user, 2026-09-23).
--
-- Recorded here so the deployed panel agrees with reality. From now on this is
-- set from the panel instead: our API token belongs to a deleted app, so the
-- live list cannot be read, and an approval arriving every day or two should
-- not each need a migration and a deploy. When the new credentials are in, the
-- live list corrects all of this by itself.

UPDATE wa_templates
   SET approval_status = 'APPROVED', modified_at = now()
 WHERE template_name = 'gp_starthere_en_v1' AND language = 'en';
