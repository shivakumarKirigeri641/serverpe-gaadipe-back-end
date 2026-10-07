-- A line in the chat before a vehicle check (user, 2026-10-07: "mention that
-- dependent servers are down and vehicle details may fail to fetch").
-- check_notice_mode: on (always) | auto (only while the VAHAN watch says down) | off.
-- Empty wording uses the built-in English / Hindi text (src/routes/public.js).
INSERT INTO app_settings (key, value) VALUES
  ('check_notice_mode', 'on'),
  ('check_notice_en', ''),
  ('check_notice_hi', '')
ON CONFLICT (key) DO NOTHING;
