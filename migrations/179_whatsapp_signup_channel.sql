-- 179_whatsapp_signup_channel.sql (user, 2026-10-15: "Vehicle searches is 0 — check everywhere
-- in this admin panel"). Since migration 136 (10 Oct) a new customer defaulted to
-- signup_channel 'web', and the WhatsApp webhook (routes/whatsapp.js) did not say otherwise,
-- so everyone who first wrote on WhatsApp since then was recorded as a website customer and
-- left out of the main admin's WhatsApp counts. The webhook now passes 'whatsapp'; this puts
-- right those already recorded: a 'web' customer whose WhatsApp chat began within five minutes
-- of their record being made, and who had not signed in on the website before that.
UPDATE users u
   SET signup_channel = 'whatsapp', modified_at = now()
 WHERE u.signup_channel = 'web'
   AND EXISTS (SELECT 1 FROM whatsapp_sessions s
                WHERE right(s.mobile, 10) = right(u.mobile, 10)
                  AND s.created_at <= u.created_at + interval '5 minutes')
   AND NOT EXISTS (SELECT 1 FROM site_sign_ins g
                    WHERE g.user_id = u.id AND g.created_at <= u.created_at + interval '5 minutes');
