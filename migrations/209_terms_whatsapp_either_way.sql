-- 209_terms_whatsapp_either_way.sql (user, 2026-10-23: "mention it in the Terms instead of keep on changing").
-- One wording that stays true whether WhatsApp is on or off, so the Terms need no change if WhatsApp is
-- disabled again: GaadiPe may also be offered on WhatsApp; if WhatsApp is ever disabled or unavailable, for
-- any reason, everything continues on gaadipe.in with the same mobile number. Wording only; versions stay,
-- so nobody is asked to agree again.

UPDATE terms_and_conditions SET modified_at = now(),
  title = 'Website, WhatsApp, SMS and Email',
  description = 'GaadiPe is offered on our website gaadipe.in, where you can check vehicles, sign in, buy reports and see your alerts, and it may also be offered on WhatsApp from our business number (business name “GaadiPe”). We contact you by SMS, email and browser notifications on the devices where you allow them, and on WhatsApp only after you write to us first or about a service you have taken; you can reply STOP at any time. If WhatsApp is ever disabled or unavailable, for any reason and for any length of time, you can continue on the web: sign in at gaadipe.in with the same mobile number, and your account, vehicles, reports, invoices and alerts are all there — alerts continue by SMS, email and browser notifications. Messages or calls from any other number claiming to be GaadiPe are not from us, and GaadiPe never asks for OTPs, card or bank details, or challan payments.'
 WHERE is_active AND title IN ('GaadiPe on the Website, WhatsApp, SMS and Email', 'GaadiPe on the Website, SMS and Email', 'GaadiPe on the Website, SMS, Email and WhatsApp');
