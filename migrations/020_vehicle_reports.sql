-- 020_vehicle_reports.sql — the vehicle report as a document, with a record of
-- who asked for it.
--
-- WHY THIS TABLE EXISTS AND NOT JUST A PDF: the Terms say a report is issued to
-- a requester who declared a lawful purpose. That declaration is worth nothing
-- unless it is attached to something — a person, a number, a moment, a device.
-- If a report is ever misused, the question will be "who obtained this, and
-- when", and the only acceptable answer is a row.
--
-- It also makes a report re-sendable. Like an invoice, the ROW is the record and
-- the PDF is a rendering of it: a lost file is regenerated with the same number
-- from the snapshot that produced it.
--
-- snapshot holds the data AS IT WAS. A report says "insurance expires 12 Nov";
-- regenerating it from today's data six months later would silently produce a
-- different document under the same number, which is the one thing a numbered
-- document must never do.

BEGIN;

CREATE TABLE IF NOT EXISTS vehicle_reports (
  id             bigserial PRIMARY KEY,
  report_number  text        NOT NULL UNIQUE,
  user_id        bigint      REFERENCES users(id),
  vehicle_id     bigint      REFERENCES vehicles(id) ON DELETE SET NULL,
  payment_id     bigint      REFERENCES payments(id) ON DELETE SET NULL,
  subscription_id bigint     REFERENCES subscriptions(id) ON DELETE SET NULL,
  reg_no         text        NOT NULL,

  -- Who asked, and from where. Filled from the checkout page where we have a
  -- browser; from WhatsApp alone there is no device to record, and the columns
  -- stay null rather than being invented.
  requested_by   text,                        -- mobile
  requester_name text,
  ip             text,
  user_agent     text,
  device         text,                        -- "Android · Chrome 128"
  channel        text        NOT NULL DEFAULT 'whatsapp',

  -- Exactly what was reported, so the same number always renders the same
  -- document however long afterwards.
  snapshot       jsonb       NOT NULL,
  pdf_path       text,
  access_token   text UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reports_user ON vehicle_reports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reg  ON vehicle_reports (reg_no, created_at DESC);

COMMIT;
