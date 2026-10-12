-- 159_clear_wa_templates.sql (user, 2026-10-12: "remove all templates which are present in
-- back-end, i will give new monitoring template"). Every row of wa_templates goes; the new
-- monitoring template is added by its own migration once the user supplies it.
--
-- Only this table. Meta's own template list is untouched (templates there are created and
-- deleted by the user). Past whatsapp_messages and broadcasts keep their template_name;
-- with no row to look up, Finance prices them at the default WhatsApp rate and the web
-- chat history leaves out the old template text.

DELETE FROM wa_templates;
