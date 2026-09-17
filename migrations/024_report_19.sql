-- 024_report_19.sql — the Rs.19 full report.
--
-- The owner flow becomes: hi -> agree -> vehicle number -> basic details -> a
-- menu offering the full report for Rs.19. One payment buys two things:
--
--   * the full report (everything except personal details) as a PDF on
--     WhatsApp, which can be downloaded again for report_valid_days (7)
--   * monitoring for the plan's duration_days (28): document expiry and new
--     challans
--
-- It is a plan of kind 'report' so every path that treats a paid watch as a
-- subscription (unlimited checks, partner commission) can tell the two apart.
-- Rs.19 is GST-inclusive, like every other price: Rs.16.10 + Rs.2.90 GST.
--
-- SAFE ON THE EXISTING PRODUCTION DATABASE, and safe to run twice:
--   * every statement is IF NOT EXISTS or ON CONFLICT, nothing is dropped
--   * no existing row is changed except the one setting named below
--   * no BEGIN/COMMIT here on purpose: scripts/migrate.js already wraps each
--     file in a transaction together with its schema_migrations row, and a
--     COMMIT inside the file would end that transaction early — the change
--     would stick even if recording it failed.

INSERT INTO plans (code, name, kind, price_paise, extra_vehicle_paise, gst_percent,
                   duration_days, max_vehicles, is_active, sort_order)
VALUES ('REPORT19', 'Full report — Rs.19 (PDF, 28-day monitoring)',
        'report', 1900, 1900, 18.00, 28, 1, true, 1)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, kind = EXCLUDED.kind, price_paise = EXCLUDED.price_paise,
  extra_vehicle_paise = EXCLUDED.extra_vehicle_paise,
  duration_days = EXCLUDED.duration_days, is_active = true;

-- owner_name_display = hidden: the report is everything EXCEPT personal
-- details, so the owner's name is not shown even masked, in chat or PDF.
INSERT INTO app_settings (key, value) VALUES
  ('report_valid_days', '7'),
  ('owner_name_display', 'hidden')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- How long the report may be downloaded again. Null on reports issued before
-- this migration, which keep following their subscription as they did.
ALTER TABLE vehicle_reports ADD COLUMN IF NOT EXISTS valid_until timestamptz;

CREATE TABLE IF NOT EXISTS feedback (
  id          bigserial PRIMARY KEY,
  user_id     bigint      REFERENCES users(id) ON DELETE SET NULL,
  mobile      text        NOT NULL,
  reg_no      text,
  body        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);

