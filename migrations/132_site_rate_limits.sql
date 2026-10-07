-- Customers on the same mobile network share one IP (2026-10-07: ad visitors were
-- refused with 429 and saw "could not reach GaadiPe"). The per-IP ceilings for the
-- public site go up; the admin keeps its own (rate_limit_admin_per_minute_ip).
UPDATE app_settings SET value = '600', modified_at = now()
 WHERE key = 'rate_limit_per_minute_ip' AND value::int < 600;
UPDATE app_settings SET value = '120', modified_at = now()
 WHERE key = 'rate_limit_handshakes_per_minute_ip' AND value::int < 120;
