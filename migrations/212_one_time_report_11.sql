-- 212_one_time_report_11.sql (user, 2026-10-25: "one more feature/pricing for ₹11 — full report one time, no
-- monitoring"; "₹11, on WhatsApp and the website, for every customer, paid or not").
--
-- REPORT11: the same full report as REPORT19 (PDF, every detail, GST invoice, +5 checks that month) but no
-- subscription and no watch — nothing is monitored and no renewal is offered. plans.monitoring says which
-- report plans start monitoring (billing.activate). Copied from REPORT19 so GST and inclusive pricing match.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS monitoring boolean NOT NULL DEFAULT true;

INSERT INTO plans (code, name, kind, price_paise, extra_vehicle_paise, gst_percent, duration_days, max_vehicles,
                   is_active, sort_order, price_is_inclusive, renewal_paise, trial_days, discount_paise, monitoring)
SELECT 'REPORT11', 'Full report — ₹11 (PDF, one time, no monitoring)', 'report', 1100, 1100, gst_percent, 0, 1,
       true, sort_order + 1, price_is_inclusive, NULL, 0, 0, false
  FROM plans WHERE code = 'REPORT19'
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, kind = 'report', price_paise = 1100, extra_vehicle_paise = 1100, duration_days = 0,
  renewal_paise = NULL, monitoring = false, is_active = true;

-- The Terms say the amount (as 184 and 193 did): one sentence, the same version — prices are shown before every
-- payment and nothing renews by itself, so this is not a new version to agree to.
UPDATE terms_and_conditions
   SET description = replace(replace(description,
         'The full vehicle report costs Rs.19 per vehicle, inclusive of GST',
         'The full vehicle report costs Rs.19 per vehicle with 28 days of monitoring, or Rs.11 per vehicle as a one-time report without monitoring, each inclusive of GST'),
         'and 28 days of monitoring of that vehicle, during which',
         'and — with the Rs.19 report only, not the Rs.11 one-time report — 28 days of monitoring of that vehicle, during which'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active
   AND description LIKE '%The full vehicle report costs Rs.19 per vehicle, inclusive of GST%';
