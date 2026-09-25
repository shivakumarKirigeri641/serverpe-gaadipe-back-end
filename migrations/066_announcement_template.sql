-- 066_announcement_template.sql — a free-text announcement the admin writes
-- each time (user, 2026-09-25).
--
-- {{1}} is a title and {{2}} a message, both typed in Broadcast and sent to
-- whoever is ticked. The title sits in the body, bold, because the panel fills
-- body blanks only; the fixed words around the blanks are what Meta needs to
-- approve it (a template may not start or end with a blank, nor be mostly
-- blanks). One quick-reply button, "Check a vehicle", which the bot answers
-- (flow.js); STOP is in the footer and handled by the bot.
--
-- `variables` is empty on purpose: there is no field to pre-fill — both blanks
-- are words the admin types. Status is PENDING until Meta approves it; the
-- live list from Meta then keeps it current.

INSERT INTO wa_templates
  (template_name, language, category, variables, header_text, body_text, footer_text, approval_status, is_active)
SELECT 'gp_announcement_en_v1', 'en', 'MARKETING', '[]'::jsonb,
       '📢 GaadiPe update',
       E'📢 *{{1}}*\n\n{{2}}\n\n— Team GaadiPe. Check any vehicle''s record right here on WhatsApp: challans, insurance, PUC and more.',
       'Reply STOP to stop messages', 'PENDING', true
 WHERE NOT EXISTS (SELECT 1 FROM wa_templates
                    WHERE template_name = 'gp_announcement_en_v1' AND language = 'en');
