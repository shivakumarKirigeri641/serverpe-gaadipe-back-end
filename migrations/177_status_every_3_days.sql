-- 177_status_every_3_days.sql (user, 2026-10-15: "₹19 + full report + 28 days monitoring, and
-- once in 3 days we send the monitoring report"; "email every 2 days is fine?"). The routine
-- update (jobs/watch.js dailyStatus) no longer runs daily for the first week: from the day
-- after monitoring starts, WhatsApp every 3 days and email / phone notification every 2 days,
-- until day 28. Alerts for a new challan or a document expiring are unchanged — at once.
INSERT INTO app_settings (key, value) VALUES
  ('watch_status_daily_days', '0'),
  ('watch_status_every_days', '3'),
  ('watch_status_email_every_days', '2')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

-- The Email and Delivery policies promised a DAILY update; they now say how often it is.
UPDATE email_policy
   SET description = replace(description, 'a daily vehicle update during its alert period',
         'a vehicle update every couple of days during its alert period, and an alert at once when something changes'),
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Emails We Send' AND is_active AND description LIKE '%a daily vehicle update during its alert period%';

UPDATE email_policy
   SET description = 'Vehicle updates are sent in the evening (India time), every couple of days while monitoring runs; an alert about a new challan or a document expiring is sent the same evening it is found. You will not receive more than one update and one summary per day. Confirmation links are sent straight away.',
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'When Emails Arrive' AND is_active AND description LIKE 'Vehicle updates are sent once a day%';

UPDATE delivery_policy
   SET description = replace(description, 'Daily vehicle updates are delivered by email in the evening',
         'Vehicle updates are delivered by email in the evening, every couple of days while monitoring runs,'),
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Email Updates' AND is_active AND description LIKE 'Daily vehicle updates are delivered by email in the evening%';
