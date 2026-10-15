-- 189_sms_winback_message_id.sql (user, 2026-10-15: "sender ID: GAADIP, message ID: 228033").
-- Fast2SMS refused the DLT template id 1277179182202755003 ("Invalid Message ID"); its DLT route
-- wants Fast2SMS's own Message ID for gp_winback_v1, which is 228033.
UPDATE sms_templates
   SET dlt_id = '228033', sender = 'GAADIP', modified_at = now()
 WHERE is_active AND (dlt_id = '1277179182202755003' OR name = 'gp_winback_v1 — GaadiPe is back')
   AND NOT EXISTS (SELECT 1 FROM sms_templates WHERE is_active AND dlt_id = '228033');
