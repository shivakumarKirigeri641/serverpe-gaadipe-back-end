-- 188_sms_template_winback.sql (user, 2026-10-15: "GAADIP sender, templateId 1277179182202755003
-- with 3 params" — DLT template gp_winback_v1, Promotional, active on Jio since 13-10-2026).
--
-- Put in the SMS broadcast's template list (migration 187). If the promotional template already
-- in Settings is this one (its wording starts "GaadiPe update:"), that entry is renamed and given
-- the GAADIP header — its message id is kept, since Settings may already hold the Fast2SMS id.
-- Otherwise it is added with the DLT template id; if Fast2SMS refuses that, put Fast2SMS's own
-- "Message ID" for gp_winback_v1 in its place (Edit, on the SMS broadcast page).
UPDATE sms_templates
   SET name = 'gp_winback_v1 — GaadiPe is back', sender = 'GAADIP', kind = 'promo',
       body = E'GaadiPe update:\nGaadiPe is now {#alphanumeric#}, Reason: {#alphanumeric#}.\nVisit {#urlott#}',
       modified_at = now()
 WHERE is_active AND (dlt_id = '1277179182202755003' OR (kind = 'promo' AND body ILIKE 'GaadiPe update:%'));

INSERT INTO sms_templates (name, kind, dlt_id, body, sender)
SELECT 'gp_winback_v1 — GaadiPe is back', 'promo', '1277179182202755003',
       E'GaadiPe update:\nGaadiPe is now {#alphanumeric#}, Reason: {#alphanumeric#}.\nVisit {#urlott#}', 'GAADIP'
 WHERE NOT EXISTS (SELECT 1 FROM sms_templates WHERE is_active AND name = 'gp_winback_v1 — GaadiPe is back');
