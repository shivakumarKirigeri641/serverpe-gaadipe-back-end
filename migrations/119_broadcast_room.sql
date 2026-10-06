-- 119_broadcast_room.sql (user, 2026-10-06: "suggest the customers batch which
-- fits Meta's rolling 24 hours ... announcement template only. The main target
-- is to unlock the next tier"). src/admin/broadcastRoom.js.
--
--   broadcast_room_buffer     left out of the suggested batch, for alerts and
--                             live customers (15)
--   broadcast_room_gap_days   someone broadcast to this many days ago or less
--                             is not suggested again (7)

INSERT INTO app_settings (key, value) VALUES
  ('broadcast_room_buffer', '15'),
  ('broadcast_room_gap_days', '7')
ON CONFLICT (key) DO NOTHING;
