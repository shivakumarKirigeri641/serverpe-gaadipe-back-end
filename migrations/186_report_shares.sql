-- 186_report_shares.sql (user, 2026-10-15: "shareable report — go ahead"). A paid report's owner
-- may share a SUMMARY of it — yes/no results, masked, with the date checked — at
-- gaadipe.in/r/<token> (site/shares.js). The link lives as long as the report's download period
-- and its owner can switch it off; views are counted. Never the PDF, never a date or an amount.
CREATE TABLE IF NOT EXISTS report_shares (
  id          bigserial   PRIMARY KEY,
  token       text        NOT NULL UNIQUE,
  report_id   bigint      NOT NULL REFERENCES vehicle_reports(id) ON DELETE CASCADE,
  user_id     bigint      REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  views       int         NOT NULL DEFAULT 0,
  last_view_at timestamptz
);
CREATE INDEX IF NOT EXISTS report_shares_report ON report_shares (report_id);
