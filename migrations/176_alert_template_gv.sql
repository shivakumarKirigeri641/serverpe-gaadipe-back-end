-- 176_alert_template_gv.sql (user, 2026-10-15: "gv_vehiclealert_en_v1 got approved"). The
-- monitoring alert template on the new WhatsApp account (WABA 1089813687242031) is
-- gv_vehiclealert_en_v1 — gp_monitoringalert_en_v1 (migration 161) no longer exists there.
-- Checked with Meta on approval: UTILITY, en, the same five values in the same order (name,
-- vehicle, document, expiry date, status) and the same three quick replies in the same order
-- (Thanks for remembering, Check vehicle, Pause this alert), so whatsapp/monitorAlert.js
-- sends it unchanged.
UPDATE app_settings SET value = 'gv_vehiclealert_en_v1', modified_at = now()
 WHERE key IN ('wa_template_monitoring', 'template_daily_status');
