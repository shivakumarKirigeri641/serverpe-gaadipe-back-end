-- 160_monitoringalert_template.sql (user, 2026-10-12): the new monitoring template, the only
-- one in wa_templates after 159. Written down as submitted; Meta decides approval, so it
-- starts PENDING. Three quick-reply buttons (Meta console only; this table has no column
-- for them): "Already renewed", "Remind me later", "Stop alerts".

INSERT INTO wa_templates
  (template_name, language, category, variables, header_text, body_text, footer_text, approval_status, is_active)
VALUES
  ('gp_monitoringalert_en_v1', 'en', 'UTILITY',
   '["first_name","vehicle","document","expiry_date","status"]'::jsonb,
   'Monitoring alert from GaadiPe',
   E'Hello *{{1}}*,\n\nMonitoring alert for your vehicle: *{{2}}*,\n\nDocument: *{{3}}*\nExpiry Date: *{{4}}*\nStatus: *{{5}}*\n\nAlways keep the documents updated to avoid fines.',
   'Team GaadiPe Services | Vehicle Monitoring', 'PENDING', true)
ON CONFLICT (template_name) DO NOTHING;
