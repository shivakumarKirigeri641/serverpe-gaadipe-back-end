-- 094_weekly_money.sql — the weekly money report (user, 2026-10-01), and the
-- rates it prices costs with, as the user gave them:
--   WhatsApp utility message ₹0.11, marketing message ₹0.85,
--   Razorpay 2.2% (used only where Razorpay has not reported its own fee).
-- Sent every Saturday from 9 am IST to finance_report_emails; switch off with
-- finance_weekly_email = false. All editable in Admin → Configuration.

INSERT INTO app_settings (key, value) VALUES
  ('whatsapp_cost_paise_utility',   '11'),
  ('whatsapp_cost_paise_marketing', '85'),
  ('razorpay_fee_percent',          '2.2')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO app_settings (key, value) VALUES
  ('finance_weekly_email',    'true'),
  ('finance_weekly_day',      '6'),
  ('finance_weekly_hour_ist', '9'),
  ('finance_report_emails',   'shivakumar641@gmail.com')
ON CONFLICT (key) DO NOTHING;
