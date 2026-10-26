-- 217_settings_rows_oct26.sql (user, 2026-10-26: "which one?" - nudge_hi_enabled was not in admin Settings).
-- The settings added on 25-26 Oct had defaults in the code but no row, and the admin can only change a setting that
-- has one (routes/adminApi.js PUT /settings). These are the code's defaults - nothing changes until the admin does.
-- DO NOTHING: a value already set by hand (e.g. nudge_hi_enabled = false on 26 Oct) is kept.
INSERT INTO app_settings (key, value) VALUES
  ('nudge_hi_enabled', 'true'),                     -- the one "Still want to check your vehicle?" reminder
  ('nudge_hi_after_minutes', '30'),
  ('nudge_hi_window_hours', '3'),
  ('nudge_per_tick', '2'),                          -- reminders every 5 minutes, at most
  ('wa_junk_mute_after', '6'),                      -- meaningless messages in 10 minutes before the pause
  ('wa_junk_mute_minutes', '60'),
  ('free_check_paid_lookups_per_day', '15'),        -- paid RC lookups for free checks, everyone together
  ('free_check_paid_lookups_per_person', '1'),
  ('admin_whatsapp_shows_all', 'true')              -- the WhatsApp admin counts website customers too
ON CONFLICT (key) DO NOTHING;
