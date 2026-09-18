-- 042_record_protection.sql — how many full records one account may open a day.
--
-- A paying customer opens a handful of full vehicle records; a scraper opens
-- hundreds. Past this many in a day (IST), the site shows the basic view with a
-- note — the customer has paid, so it is never an error, and their PDF report
-- stays downloadable — and the admin is told (security event full_view_cap).

INSERT INTO app_settings (key, value) VALUES ('full_views_per_day_user', '25')
ON CONFLICT (key) DO NOTHING;
