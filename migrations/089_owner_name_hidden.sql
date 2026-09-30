-- 089_owner_name_hidden.sql — no owner name in any customer report, masked or
-- not (user, 2026-09-30). The paid WhatsApp report showed "S****R V K****I";
-- now it shows only which owner this is ("2nd owner"). Chassis and engine were
-- already never shown.

INSERT INTO app_settings (key, value) VALUES ('owner_name_display', 'hidden')
ON CONFLICT (key) DO UPDATE SET value = 'hidden';
