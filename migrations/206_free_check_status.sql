-- 206_free_check_status.sql (user, 2026-10-22: "go ahead with this as you recommend" — the GaadiPe app at
-- gaadipe.in/go, a dashboard of warning lights). The free check before sign-in shows each document's state
-- (Valid / Due soon / Expired) and how many challans are pending, with the health score — never a date.
-- The dates, each challan, the loan, blacklist and owners stay in sign-in and the ₹19 report.
-- Switch it off in Configuration (free_check_show_status) to go back to make and model only.
INSERT INTO app_settings (key, value) VALUES ('free_check_show_status', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();
