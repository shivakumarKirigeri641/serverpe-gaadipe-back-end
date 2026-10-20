-- 194_whatsapp_number_7353122415.sql (user, 2026-10-20: "all working, let's get back to WhatsApp
-- based now"). GaadiPe's new WhatsApp number, +91 73531 22415, in a new business portfolio
-- (WABA 1155238370163448, phone number id 1416319281557223). The old +91 97396 22631 was banned
-- (SCAM strikes 16-18 Oct). Invoices, PDFs and the site's contact details read business_details.
-- WhatsApp sending itself is switched with scripts/wa-golive.js (test / live / off), not here.
UPDATE business_details SET whatsapp_number = '+917353122415'
 WHERE whatsapp_number IS DISTINCT FROM '+917353122415';
UPDATE business_details SET support_phone = '+917353122415'
 WHERE support_phone = '+919739622631';

-- The website's top bar said "Check any vehicle … right here on gaadipe.in" while WhatsApp was off
-- (192). The site is WhatsApp-first again; its hanging notice tells people about the new number.
INSERT INTO app_settings (key, value) VALUES ('site_notice_on', 'false')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
