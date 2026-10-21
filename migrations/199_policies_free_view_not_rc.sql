-- 199_policies_free_view_not_rc.sql (user, 2026-10-21: "did you change the terms and policies accordingly?").
-- The policies say what the site now does. Wording only; the versions stay, so nobody is asked to agree again.
--   1. After sign-in the free view shows HOW MANY documents and challans need attention, not the dates
--      (free_view_detail 'count', migration 198); the dates are in the paid report.
--   2. GaadiPe issues no RC card, PUC, insurance or certificate; the official digital RC is free in
--      DigiLocker and mParivahan (as the website, the report footer and the chat say).
--   3. No WhatsApp left in the service-channel lists (migration 197); vehicle-data providers may process
--      data outside India (Way2API, migration 196).
-- Each change is a replace() of the exact old words, so a clause edited by hand since is left as it is.

UPDATE terms_and_conditions SET modified_at = now(), description = replace(description,
  'After signing in you also see the validity dates of its documents and how many challans are pending; the loan, blacklist and NOC status, each challan in detail and the other particulars are in the full report.',
  'After signing in you also see how many of its documents and challans need attention; the validity dates, the loan, blacklist and NOC status, each challan in detail and the other particulars are in the full report.')
 WHERE is_active AND title = 'Free Check Before Signing In';

UPDATE terms_and_conditions SET modified_at = now(), description = replace(description,
  'the detail behind the free check, being loan or hypothecation status,',
  'the detail behind the free check, being the validity date of every document, loan or hypothecation status,')
 WHERE is_active AND title = 'What You Are Buying';

UPDATE refund_policy SET modified_at = now(), description = replace(description,
  'The free check shows the vehicle, its registration details and the expiry dates of its documents, and states plainly what the paid report adds.',
  'The free check shows the vehicle and its registration details and, after signing in, how many of its documents and challans need attention, and states plainly what the paid report adds.')
 WHERE is_active AND title = 'What You See Before You Pay';

UPDATE terms_and_conditions SET modified_at = now(), description = replace(description,
  'on the channels we offer, such as SMS, email, browser notifications and, where available, WhatsApp.',
  'on the channels we offer — SMS, email and browser notifications. GaadiPe gives reports, alerts and reminders only: it does not issue a registration certificate (RC card), PUC certificate, insurance policy or any other certificate, and its reports are not official documents. The official digital RC is available free in DigiLocker and mParivahan.')
 WHERE is_active AND title = 'Description of Service';

UPDATE terms_and_conditions SET modified_at = now(), description = replace(description,
  '(SMS, email and, now or in future, WhatsApp)', '(SMS, email and browser notifications)')
 WHERE is_active AND title = 'Service Availability';

UPDATE privacy_policy SET modified_at = now(), description = replace(description,
  'our SMS, email, notification and messaging providers (including WhatsApp / Meta where used) for communicating with you;',
  'our SMS, email and notification providers for communicating with you;')
 WHERE is_active AND title = 'Data Sharing';

UPDATE privacy_policy SET modified_at = now(), description = replace(description,
  'for example email, messaging, analytics, advertising and cloud services',
  'for example email, messaging, vehicle-data, analytics, advertising and cloud services')
 WHERE is_active AND title = 'Processing Outside India';
