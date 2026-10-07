-- An email for every visit to gaadipe.in (user, 2026-10-07: "I need a mail when
-- someone taps my website"). src/jobs/notify.js → visits(); switched from the
-- web admin → Emails to you. On to begin with.
INSERT INTO app_settings (key, value) VALUES ('notify_visits', 'true')
ON CONFLICT (key) DO NOTHING;
