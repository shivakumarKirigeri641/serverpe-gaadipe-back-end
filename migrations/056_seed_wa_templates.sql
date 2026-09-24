-- 056_seed_wa_templates.sql — the templates, written down (user, 2026-09-23).
--
-- wa_templates has existed and been empty since the beginning. This fills it,
-- because a template that lives only in Meta's console has two problems: the
-- panel cannot show a template list when Meta is unreachable — which is the
-- state GaadiPe is in right now, its app having been deleted — and nobody can
-- read what a message will actually say without logging in to Facebook.
--
-- META REMAINS THE AUTHORITY ON APPROVAL. What is written here is what was
-- SUBMITTED; whether it is APPROVED is Meta's answer, and the panel asks Meta
-- when it can. So approval_status starts at PENDING and is corrected from the
-- live list whenever that list can be read. A row here has never, by itself,
-- made a template sendable.
--
-- variables records what each {{n}} is filled with, in order, which is what the
-- Broadcast screen needs to offer the right dropdown per template.

INSERT INTO wa_templates
  (template_name, language, category, variables, header_text, body_text, footer_text, approval_status, is_active)
VALUES
  ('gp_monitoring_alert_en_v1', 'en', 'UTILITY',
   '["first_name","last_vehicle","documents","action"]'::jsonb,
   'Monitoring alert from GaadiPe',
   E'Hi {{1}},\n\nVehicle: {{2}}\nStatus: {{3}}\n\nAction: {{4}}\n\nRegards,\nGaadiPe',
   'Powered by: ServerPe App Solutions', 'PENDING', true),

  ('gp_renewal_en_v1', 'en', 'UTILITY',
   '["first_name","last_vehicle","ends_on","price"]'::jsonb,
   'Monitoring ending soon',
   E'Hi {{1}},\n\nMonitoring for {{2}} ends on {{3}}.\n\nRenew for another 28 days for {{4}} — new challans, and a warning before insurance, PUC, road tax or fitness expires.\n\nNothing renews automatically.\n\nRegards,\nGaadiPe',
   'Powered by: ServerPe App Solutions', 'PENDING', true),

  ('gp_support_reply_en_v1', 'en', 'UTILITY',
   '["first_name","ticket_no","reply"]'::jsonb,
   'GaadiPe support',
   E'Hi {{1}},\n\nAbout your ticket {{2}}:\n\n{{3}}\n\nReply here if you need anything else.\n\nRegards,\nGaadiPe',
   'Powered by: ServerPe App Solutions', 'PENDING', true),

  ('gp_starthere_en_v1', 'en', 'MARKETING',
   '["first_name","last_vehicle"]'::jsonb,
   NULL,
   E'Hi *{{1}}*, GaadiPe is now on WhatsApp.\n\nThe vehicle you checked — *{{2}}* — can be checked here any time. Send the number and the details come straight into this chat.\n\nTap hi below to begin. 👋',
   'Reply STOP to stop · Powered by ServerPe App Solutions', 'PENDING', true),

  ('gp_winback_en_v1', 'en', 'MARKETING',
   '["first_name","last_vehicle","ends_on","price"]'::jsonb,
   'Your monitoring has stopped',
   E'Hi {{1}},\n\nMonitoring for {{2}} stopped on {{3}}.\n\nSince then we have not been checking for new challans, or watching your insurance, PUC and road tax dates. Start again for {{4}} and we will pick it up from today.\n\nRegards,\nGaadiPe',
   'Reply STOP to stop · Powered by ServerPe App Solutions', 'PENDING', true)
ON CONFLICT DO NOTHING;

-- One row per name and language: raising a v2 means a new name, never an edit
-- to a row that a sent message already pointed at.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_templates_name
    ON wa_templates (template_name, language);
