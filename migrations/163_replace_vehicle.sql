-- 163_replace_vehicle.sql (user, 2026-10-13: "small fee 9 + GST for replace vehicle").
--
-- REPLACE VEHICLE: running paid monitoring moves from one vehicle to another for
-- ₹9 + 18% GST = ₹10.62. The subscription keeps its end date (the days left carry
-- over, none are added); the old vehicle comes off the customer's list and its
-- alerts stop; its report and invoice stay. The new vehicle's full report is not
-- included. Once per purchase, within replace_window_days of it (pay/replace.js).

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_kind_check;
ALTER TABLE plans ADD CONSTRAINT plans_kind_check CHECK (kind IN ('watch', 'report', 'fleet', 'replace'));

INSERT INTO plans (code, name, kind, price_paise, gst_percent, duration_days, price_is_inclusive, is_active, sort_order)
VALUES ('REPLACE9', 'Replace vehicle — ₹9 + GST (monitoring moves to another vehicle)', 'replace', 1062, 18.00, 0, true, true, 20)
ON CONFLICT (code) DO NOTHING;

INSERT INTO app_settings (key, value) VALUES
  ('replace_enabled', 'true'),
  -- Days after the purchase (or renewal) in which the vehicle may be replaced; 0 = any time while it runs.
  ('replace_window_days', '7')
ON CONFLICT (key) DO NOTHING;
