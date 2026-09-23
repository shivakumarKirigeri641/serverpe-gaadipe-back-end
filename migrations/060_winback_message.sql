-- 060_winback_message.sql — a win-back worth sending (user, 2026-09-23).
--
-- The first draft led with GaadiPe's system stopping, which is our problem and
-- not the customer's. What the customer cares about is what they are now blind
-- to: a challan can arrive without them being told, and insurance and PUC lapse
-- quietly. So the message leads with the silence, names the three things that
-- actually bite, and asks once.
--
-- No manufactured urgency. This audience has been sold to badly before, and a
-- marketing template that gets reported is a marketing template that stops
-- being delivered — to everybody, not only to whoever reported it.

UPDATE wa_templates
   SET header_text = 'Your vehicle is no longer being watched',
       body_text = E'Hi {{1}},\n\nGaadiPe stopped watching {{2}} on {{3}}. Since then a new challan could have arrived, or your insurance or PUC could have lapsed, and nobody would have told you.\n\nStart again for {{4}}. We check the Government record today, and keep checking — so next time something changes on your vehicle, you hear it from us first.\n\nRegards,\nGaadiPe',
       approval_status = 'PENDING',
       modified_at = now()
 WHERE template_name = 'gp_winback_en_v1' AND language = 'en';
