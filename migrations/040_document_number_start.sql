-- 040_document_number_start.sql — where each day's invoice and report numbers begin.
--
-- Numbers are per day: INV20260918GP1, GP2, … and RPT20260918GP1, …  The
-- start is a setting (default 1). A number, once issued, must never be issued
-- again — so after a database clean or rebuild on a day that already has
-- documents, raise this above the highest number given out that day.

INSERT INTO app_settings (key, value) VALUES ('document_number_start', '1')
ON CONFLICT (key) DO NOTHING;
