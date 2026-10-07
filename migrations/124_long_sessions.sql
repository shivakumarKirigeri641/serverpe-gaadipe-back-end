-- 124_long_sessions.sql (user, 2026-10-07: "like WhatsApp — whenever opened,
-- straight into the account; only Sign out asks again"). A website sign-in
-- now lasts 365 days from its LAST use (src/site/auth.js sessionFor), so
-- anyone who opens GaadiPe at least once a year stays signed in. Sign-out and
-- deactivation still end it at once; the device keeps it sealed (lib/vault.js).
-- Only the old default is changed: a value set by hand is left alone.

UPDATE app_settings SET value = '365', modified_at = now()
 WHERE key = 'site_session_days' AND value = '30';
