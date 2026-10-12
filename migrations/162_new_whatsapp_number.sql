-- 162_new_whatsapp_number.sql (user, 2026-10-12: "replace old number everywhere from
-- 6363271302 to 9739622631"). Migration 007 now seeds the new number, but it ran long
-- ago, so the stored business details (Terms, Privacy, invoices, contact pages) are
-- changed here. Only where the old number still stands.

UPDATE business_details SET whatsapp_number = '+919739622631'
 WHERE whatsapp_number IN ('+916363271302', '916363271302', '6363271302');

UPDATE business_details SET support_phone = '+919739622631'
 WHERE support_phone IN ('+916363271302', '916363271302', '6363271302');
