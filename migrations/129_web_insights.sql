-- 129_web_insights.sql — THE WEB ADMIN'S INSIGHTS (user, 2026-10-07; spec
-- §56, §82, §120–122). Thresholds for the website's anomaly alerts
-- (admin/alerts.js), and the lead-scoring weights (admin/insights.js), all
-- changeable from the web admin without code.

INSERT INTO app_settings (key, value) VALUES
  ('alert_otp_success_pct',      '30'),   -- sign-ins per code sent below this (%), 5+ sent in 30 min: critical
  ('alert_free_check_fail_pct',  '70'),   -- free chat checks failing above this (%), 5+ in 30 min
  ('alert_traffic_drop_pct',     '60'),   -- visitors in an hour below the 7-day hourly average by this (%)
  ('alert_conversion_drop_pct',  '50'),   -- today's visit-to-paid rate below the 7-day rate by this (%)
  ('alert_stuck_payment_count',  '2'),    -- this many visitors idle 5 min on the payment step
  -- Lead scoring: points per behaviour, and the bands (spec §121).
  ('web_lead_scoring', '{"landing":1,"vehicle_search":5,"vehicle_details":5,"report_cta":10,"payment_page":20,"payment_failed":10,"payment_success":50,"returning":5,"signed_in":5,"bands":{"warm":11,"hot":31,"very_hot":61},"days":7}')
ON CONFLICT (key) DO NOTHING;
