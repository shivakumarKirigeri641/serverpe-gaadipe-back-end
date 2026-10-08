-- TEST-MODE PURCHASES FOR THE OWNER ONLY (user, 2026-10-08: "allow a full report
-- for me by calling test mode Razorpay — only for me as admin").
-- A customer whose mobile is listed here AND who is marked internal pays with the
-- Razorpay TEST keys: no real money, booked at ₹0, invoice numbered TEST-…
-- (pay/razorpay.js isTestBuyer). Empty the value to switch it off.
INSERT INTO app_settings (key, value) VALUES ('pay_test_mobiles', '9886122415')
ON CONFLICT (key) DO NOTHING;
