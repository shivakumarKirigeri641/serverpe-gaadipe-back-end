-- 101_report_layout.sql — which layout each report PDF was printed with
-- (src/pdf/vehicleReport.js LAYOUT). Reports printed before this have none and
-- are re-printed from their own snapshot, with personal details masked, the
-- next time they are downloaded (src/pay/rebuild.js). No vehicle lookup.

ALTER TABLE vehicle_reports ADD COLUMN IF NOT EXISTS pdf_layout int;
