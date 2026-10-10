-- 154_renewal_11_and_monthly_checks.sql (user, 2026-10-10)
--
--   "₹11 for a repeat vehicle, ₹19 for a new one"   plans.renewal_paise 1062 → 1100:
--        a vehicle this customer paid for before, whose last paid report ended no
--        more than report_renewal_window_days (30) ago (pay/billing.reportPriceFor).
--   "pay a report to unlock more — 5"               signed in: 10 checks a day and
--        free_checks_per_month (30) a month, plus checks_per_report_bonus (5) for
--        every report paid that month (util/quota.js). Shown to the customer.
--   "full tracking of what the user taps or types" the chat's sent messages are
--        recorded with the taps (vehicle numbers and questions; a mobile number
--        partly hidden; sign-in codes, names and emails never) — Privacy 22 says so.

UPDATE plans SET renewal_paise = 1100 WHERE code = 'REPORT19';

INSERT INTO app_settings (key, value) VALUES
  ('report_renewal_window_days', '30'),
  ('free_checks_per_month', '30'),
  ('checks_per_report_bonus', '5')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

UPDATE terms_and_conditions
   SET description = 'The full vehicle report costs Rs.19 per vehicle, inclusive of GST and of payment-gateway charges — the amount shown is the amount you pay, with nothing added at checkout. '
         || 'One payment covers one vehicle and buys three things: the full report as a PDF, which you may download again for 7 days; '
         || 'the detail behind the free check, being loan or hypothecation status, blacklist and NOC status, the challan list with offence and place, and masked policy and certificate numbers; '
         || 'and 28 days of monitoring of that vehicle, during which you are told if a new challan appears or a document is close to expiring. '
         || 'Renewing a vehicle you have already bought costs Rs.11 for another 28 days, provided its last report ended no more than 30 days earlier; after that, the vehicle is charged Rs.19 again. '
         || 'There is NO auto-charge and NO auto-renewal: monitoring simply stops at the end of its term, and no card or payment instrument is stored. '
         || 'Checking a vehicle remains free after signing in, up to 10 vehicles a day and 30 a month; every report you buy adds 5 more checks for that month. '
         || 'Checking the same vehicle again within an hour does not count. '
         || 'Once a report has been delivered the purchase is final; please see the Refund Policy.',
       version = '3.1', effective_from = CURRENT_DATE, modified_at = now()
 WHERE id = 23;

UPDATE privacy_policy
   SET description = 'When you use gaadipe.in — signed in or not — we record the pages you open, what you tap (for example "Check another" or "Full report"), '
         || 'and the messages you send in the GaadiPe chat, with the time, your browser and device, and your approximate location. '
         || 'From the messages we keep the vehicle numbers and the questions you type. A mobile number is kept with most of its digits hidden; '
         || 'sign-in codes, and the name and email address you enter, are never kept in this record (your name and email are kept only in your profile). '
         || 'We use this to support you, to fix problems, to protect the service from misuse, and to improve GaadiPe. '
         || 'If you sign in, the record made on that browser before signing in is linked to your account. '
         || 'This history is kept for up to 180 days and then deleted.',
       title = 'How You Use the Website',
       version = '2.0', effective_from = CURRENT_DATE, modified_at = now()
 WHERE id = 22;

UPDATE privacy_policy
   SET description = replace(replace(description,
         'to run the one-free-check-a-day limit', 'to run the daily free-check limit'),
         'If you later sign in on the same browser, the record is linked to your account.',
         'If you later sign in on the same browser, the record is linked to your account and the vehicles you checked appear in My vehicles.'),
       version = '1.1', effective_from = CURRENT_DATE, modified_at = now()
 WHERE id = 26;
