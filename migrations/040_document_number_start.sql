-- 040_document_number_start.sql — where each day's invoice and report numbers begin.
--
-- Numbers are per day: INV20260918GP2, GP3, … and RPT20260918GP2, …  They
-- start at 2 because GP1 is already in use (user, 2026-09-18). A number,
-- once issued, must never be issued again — so after a database clean or
-- rebuild, raise this above anything already given out that day.

INSERT INTO app_settings (key, value) VALUES ('document_number_start', '2')
ON CONFLICT (key) DO UPDATE SET value = '2', modified_at = now();
