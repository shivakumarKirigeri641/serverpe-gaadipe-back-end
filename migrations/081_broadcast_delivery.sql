-- 081_broadcast_delivery.sql — each broadcast message's WhatsApp id (user,
-- 2026-09-27), so the panel's live progress can show what Meta reported
-- after "sent": delivered, read, or failed on the phone's side.

ALTER TABLE whatsapp_broadcast_targets ADD COLUMN IF NOT EXISTS wa_message_id text;
CREATE INDEX IF NOT EXISTS idx_wa_status_logs_message ON whatsapp_status_logs (wa_message_id);
