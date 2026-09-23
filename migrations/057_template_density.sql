-- 057_template_density.sql — longer bodies, same variables (user, 2026-09-23).
--
-- Meta refused gp_monitoring_alert_en_v1: "This template has too many
-- variables for its length." It measures how much fixed text a template
-- carries against how many {{n}} it holds, and four variables over about fifty
-- characters of real writing reads to it as a spam shell rather than a message.
--
-- The fix is not to drop a variable — each of the four is something the
-- customer needs — but to write the message properly. It says what it is, what
-- was checked and what happens next, which is what a person reading it wants
-- anyway. The parameters are unchanged in number and order, so no sending code
-- moves: [name, vehicle, documents, action] still fills {{1}}–{{4}}.
--
-- gp_support_reply_en_v1 is lengthened for the same reason before Meta says so:
-- three variables over ninety characters was close to the same edge.

UPDATE wa_templates
   SET body_text = E'Hi {{1}},\n\nThis is your monitoring update from GaadiPe for vehicle {{2}}, checked against the Government record today.\n\nStatus: {{3}}\n\nAction: {{4}}\n\nWe will keep checking and tell you if anything changes.\n\nRegards,\nGaadiPe',
       approval_status = 'PENDING',
       modified_at = now()
 WHERE template_name = 'gp_monitoring_alert_en_v1' AND language = 'en';

UPDATE wa_templates
   SET body_text = E'Hi {{1}},\n\nThank you for writing to GaadiPe support. Here is our answer to your ticket {{2}}.\n\n{{3}}\n\nIf this does not settle it, reply to this message and we will pick it up again.\n\nRegards,\nGaadiPe',
       approval_status = 'PENDING',
       modified_at = now()
 WHERE template_name = 'gp_support_reply_en_v1' AND language = 'en';
