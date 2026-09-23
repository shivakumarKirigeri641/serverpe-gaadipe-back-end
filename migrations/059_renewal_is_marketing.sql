-- 059_renewal_is_marketing.sql — the renewal notice is an offer (user, 2026-09-23).
--
-- Meta categorised gp_renewal_en_v1 as MARKETING, and it is right to. UTILITY
-- covers an update about something already bought; the moment a message names
-- a price and asks for it, it is a sale. Ours does exactly that, deliberately —
-- hiding the price to save a few paise per send would cost more in renewals
-- than it saved in fees.
--
-- What follows from being MARKETING: an opt-out in the footer, which is now
-- there, and a higher per-message cost. The monitoring alert and the support
-- reply stay UTILITY — neither sells anything.

UPDATE wa_templates
   SET category = 'MARKETING',
       footer_text = 'Reply STOP to stop · Powered by ServerPe App Solutions',
       approval_status = 'PENDING',
       modified_at = now()
 WHERE template_name = 'gp_renewal_en_v1' AND language = 'en';
