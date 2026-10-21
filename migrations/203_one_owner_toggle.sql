-- 203_one_owner_toggle.sql (user, 2026-10-21: "I just need one toggle — off: do not show the owner name before
-- sign-in, show it after; on: before and after"). free_check_show_owner is that toggle (false now, from 202);
-- signed-in customers always see the owner's name, masked (routes/siteApi.js freeViewOpts), so the separate
-- after-sign-in switch from 202 is removed.
DELETE FROM app_settings WHERE key = 'free_view_show_owner';
