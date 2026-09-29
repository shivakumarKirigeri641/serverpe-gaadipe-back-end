-- 087_unused_templates.sql — settings for WhatsApp templates that are not on
-- the account (user, 2026-09-29). Nothing reads these any more: alerts use
-- gp_monitoring_alert_en_v1 (template_daily_status), renewals
-- gp_renewal_en_v1 (wa_template_renewal), and trials are off.

DELETE FROM app_settings WHERE key IN (
  'template_vehicle_alert_en',
  'template_vehicle_alert_hi',
  'template_vehicle_alert_fallback',
  'template_vehicle_alert_languages_live',
  'template_renewal_due',
  'template_trial_ending'
);
