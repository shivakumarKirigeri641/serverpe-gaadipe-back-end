-- 034_messaging_costs.sql — what each message costs, taken out of take-home.
--
-- WhatsApp: every business-initiated template (payment, delivery, the 28 days
-- of monitoring alerts) is charged by Meta; replies inside an open window are
-- not. SMS: every sign-in code sent through the DLT route is charged.
-- Rates in paise, editable in Settings.

INSERT INTO app_settings (key, value) VALUES
  ('whatsapp_message_cost_paise', '11'),
  ('sms_otp_cost_paise',          '25')
ON CONFLICT (key) DO NOTHING;
