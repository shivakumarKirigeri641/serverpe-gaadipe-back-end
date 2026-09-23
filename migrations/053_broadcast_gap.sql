-- 053_broadcast_gap.sql — the pause between two broadcast messages (user, 2026-09-23).
--
-- Sending is strictly one at a time; this is how long GaadiPe waits after a
-- message has gone before starting the next one. A gap is not politeness: a
-- number that emits messages as fast as the API accepts them reads as a bulk
-- sender, which is what Meta rates a new number on.

INSERT INTO app_settings (key, value) VALUES ('whatsapp_broadcast_gap_ms', '1500')
ON CONFLICT (key) DO NOTHING;
