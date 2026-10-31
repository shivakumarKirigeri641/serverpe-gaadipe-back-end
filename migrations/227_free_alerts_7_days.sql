-- 227: FREE ALERTS 7 DAYS, NO DAILY NUMBER IN THE TEXTS (user, 2026-10-31: "let them check any vehicle, do not put
-- '5 vehicles check free daily' ... instead of 14 days, put 7 days better"). Every vehicle checked from now is watched
-- free for 7 days (site/freeMonitor.autoStart; periods already started keep their end date). The 5 new vehicles a
-- day (migration 225) stays as a silent guard; the Terms still state it, as they must.
INSERT INTO app_settings (key, value) VALUES ('free_monitor_days', '7')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

UPDATE terms_and_conditions
   SET description = replace(replace(description,
         'is monitored free for 14 days from that check', 'is monitored free for 7 days from that check'),
         'When the 14 days end, monitoring simply stops', 'When the 7 days end, monitoring simply stops'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Free Monitoring' AND is_active AND description LIKE '%14 days%';

UPDATE terms_and_conditions
   SET description = replace(description, 'Every vehicle checked is monitored free for 14 days.',
         'Every vehicle checked is monitored free for 7 days.'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active AND description LIKE '%monitored free for 14 days%';
