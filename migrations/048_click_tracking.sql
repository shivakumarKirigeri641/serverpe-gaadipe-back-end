-- 048_click_tracking.sql — every click a signed-in customer makes on gaadipe.in
-- is recorded (user, 2026-09-21), and the admin's Live page keeps a table per
-- customer of everything they did: pages, clicks and actions, across visits.
--
-- WHAT A CLICK RECORDS: the page, what was clicked (its label, e.g. "Get the
-- full report", and kind: button / link / tab), and where a link points. NEVER
-- what the customer typed — no mobile numbers, emails, codes or vehicle
-- numbers typed into a field.

ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS current_detail text;   -- the last thing clicked
CREATE INDEX IF NOT EXISTS idx_site_activity_user_id ON site_activity (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_site_activity_kind ON site_activity (kind, created_at DESC);

INSERT INTO app_settings (key, value) VALUES
  ('track_clicks',             'true'),   -- record customers' clicks on the site
  ('track_clicks_per_minute',  '120'),    -- per signed-in session; beyond it clicks are dropped
  ('activity_retention_days',  '180')     -- page, click and action history older than this is deleted
ON CONFLICT (key) DO NOTHING;

/* A NEW privacy section; existing text is not changed. */
INSERT INTO privacy_policy (id, title, description, display_order, is_active, version, effective_from)
SELECT m.nid, 'How You Use the Website',
       'When you are signed in to gaadipe.in, we record the pages you open and what you click or tap — for example "Check a vehicle" or "Get the full report" — with the time, so we can support you, fix problems and improve the service. We do not record what you type into any field. This history is kept for up to 180 days and then deleted. Visitors who are not signed in are counted only in aggregate by Google Analytics.',
       m.nord, true, '1.2', CURRENT_DATE
  FROM (SELECT coalesce(max(id), 0) + 1 AS nid, coalesce(max(display_order), 0) + 1 AS nord FROM privacy_policy) m
 WHERE NOT EXISTS (SELECT 1 FROM privacy_policy WHERE title = 'How You Use the Website');
