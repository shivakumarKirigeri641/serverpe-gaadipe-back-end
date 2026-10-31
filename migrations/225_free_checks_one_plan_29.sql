-- 225: FREE CHECKS + ONE PLAN (user, 2026-10-31, after friends' advice: "keep GaadiPe for RC ... remove all check
-- plans and introduce free checks (cap up to 5 vehicles per day) and 29 (inclusive tax) + 50 days monitoring
-- (alternate days of WhatsApp template + daily email). For free check customers, for checked vehicles send on
-- alternate days for 14 days starting from now"; "replace option for 20 + tax"; "remove ₹11, only ₹29").
--
--   * the check packs (CHECKS5 / 12 / 25) and the ₹11 one-time report (REPORT11) off sale - pack holders keep
--     their unused checks until they expire (check_credits untouched)
--   * REPORT19 becomes the one plan: ₹29 including GST, full report + 50 days of monitoring, no bonus checks
--     (the code REPORT19 stays - the code finds the report plan by it)
--   * replace vehicle: ₹20 + GST = ₹23.60
--   * free checks: up to 5 NEW vehicles a day per customer, enforced; no monthly cap; a vehicle already on their
--     list or with a report never counts; up to 5 paid RC lookups a day per person, 200 a day in all
--   * every vehicle found on a check from now on is watched free for 14 days (site/freeMonitor.autoStart)
--   * the update while monitoring runs: WhatsApp every other day, email every day, for the whole period;
--     at most 4 WhatsApp updates a minute and 150 a day (jobs/watch.js dailyStatus), paid customers first
-- Every value stays editable in the web admin (Settings, Plans).

UPDATE plans SET is_active = false WHERE kind = 'checks' OR code = 'REPORT11';
UPDATE plans
   SET price_paise = 2900, discount_paise = 0, duration_days = 50, check_credits = 0, is_active = true,
       name = 'Full report — ₹29 incl. GST (PDF, 50-day monitoring)'
 WHERE code = 'REPORT19';
UPDATE plans
   SET price_paise = 2360, name = 'Replace vehicle — ₹20 + GST (₹23.60; monitoring moves to another vehicle)'
 WHERE code = 'REPLACE9';

-- DO UPDATE: these are the owner's decision of today, not defaults.
INSERT INTO app_settings (key, value) VALUES
  ('check_packs_enabled', 'false'),
  ('checks_enforce', 'true'),
  ('free_checks_per_day', '5'),
  ('free_checks_per_day_trial', '5'),
  ('free_checks_per_month', '0'),
  ('free_check_paid_lookups_per_person', '5'),
  ('free_check_paid_lookups_per_day', '200'),
  ('free_monitor_auto', 'true'),
  ('free_monitor_days', '14'),
  ('watch_daily_status_enabled', 'true'),
  ('watch_status_daily_days', '0'),
  ('watch_status_every_days', '2'),
  ('watch_status_email_every_days', '1'),
  ('watch_status_alternate_until_day', '0'),
  ('watch_status_wa_per_minute', '4'),
  ('watch_status_wa_per_day', '150')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- The Terms and the Refund policy name the amounts (as 184, 212-216 did): the same version - prices are shown
-- before every payment and nothing renews by itself, so this is not a new version to agree to.
UPDATE terms_and_conditions
   SET description = replace(replace(replace(description,
         'The full vehicle report costs Rs.19 per vehicle with 28 days of monitoring, or Rs.11 per vehicle as a one-time report without monitoring, each inclusive of GST',
         'The full vehicle report costs Rs.29 per vehicle, inclusive of GST, with 50 days of monitoring'),
         'and — with the Rs.19 report only, not the Rs.11 one-time report — 28 days of monitoring of that vehicle, during which',
         'and 50 days of monitoring of that vehicle, during which'),
         'costs Rs.15 for another 28 days', 'costs Rs.15 for another 50 days'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active;

UPDATE terms_and_conditions
   SET description = replace(description, 'after that, the vehicle is charged Rs.19 again', 'after that, the vehicle is charged the full report price again'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active AND description LIKE '%the vehicle is charged Rs.19 again%';

UPDATE terms_and_conditions
   SET description = replace(description, 'Rs.9 plus GST (Rs.10.62) instead of Rs.19,', 'Rs.9 plus GST (Rs.10.62) instead of the full price,'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Referral Offer — QuizPe Instant Quiz' AND is_active AND description LIKE '%instead of Rs.19,%';

-- Free monitoring is now automatic on every vehicle checked from today (site/freeMonitor.autoStart).
UPDATE terms_and_conditions
   SET description = 'Every vehicle you check from 31 October 2026 is monitored free for 14 days from that check — '
         || 'once per vehicle per customer. Before that date, free monitoring was offered for one vehicle per mobile '
         || 'number, and a period already started runs to its end. No payment is taken and no payment instrument is '
         || 'required. During the free period we send a short update on the vehicle every other day on WhatsApp (if '
         || 'you have agreed to messages there and not replied STOP) and by email (if you have confirmed one). When '
         || 'the 14 days end, monitoring simply stops; we tell you a little before, and you may continue with the full '
         || 'report for Rs.29 per vehicle, inclusive of GST, with 50 days of monitoring. Nothing renews or is charged '
         || 'automatically. We may change or withdraw this offer for new checks at any time.',
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Free Monitoring' AND is_active;

-- The packs sentence (migrations 213-216) becomes the free checks.
UPDATE terms_and_conditions
   SET description = regexp_replace(description,
         ' Your first vehicle check is free\. Further checks use check credits:.*?Unused checks expire and are not refunded\.',
         ' Vehicle checks are free, up to 5 new vehicles a day per customer; a vehicle already checked can be checked '
         || 'again free. Every vehicle checked is monitored free for 14 days. Check credits bought earlier stay usable '
         || 'until they expire, and are not refunded.'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'What You Are Buying' AND is_active AND description LIKE '%check credits%';

UPDATE terms_and_conditions
   SET description = replace(description, 'for Rs.15, inclusive of GST (Rs.12.71 plus Rs.2.29 GST)',
         'for Rs.23.60, inclusive of GST (Rs.20 plus Rs.3.60 GST)'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Replace Vehicle' AND is_active AND description LIKE '%for Rs.15, inclusive of GST (Rs.12.71 plus Rs.2.29 GST)%';

UPDATE refund_policy
   SET description = replace(description, 'The Rs.15 fee (inclusive of GST) to replace a vehicle',
         'The Rs.23.60 fee (Rs.20 plus GST) to replace a vehicle'),
       effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Replace Vehicle Fee' AND is_active AND description LIKE '%The Rs.15 fee (inclusive of GST) to replace a vehicle%';
