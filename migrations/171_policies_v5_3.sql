-- 171_policies_v5_3.sql (user, 2026-10-14: "include whatever is required for my safety").
-- A review of every policy against what GaadiPe actually does. Version 5.3 is above every
-- policy in force (5.2), so the bot and the site ask everyone to agree once more
-- (flow.js policyVersion) — the corrected text is then on record for every customer.
--
--   Data source   Terms 2/6, Liability 2, Privacy 4: data also comes from authorised
--                 third-party providers when ULIP is down (eChallan.app, the RC backup) —
--                 said so, not "ULIP only"
--   Grievance     Privacy 12 names the Grievance Officer with contact details (DPDP Act)
--   Sharing       Privacy 7 names the analytics and advertising partners
--   Retention     Privacy 9 gives concrete periods
--   Channels      WhatsApp-only wording made channel-neutral (Terms 2/15, Privacy 10,
--                 Consent 9/10); promotional SMS 10 am – 9 pm (Terms 22)
--   Closing       Refund: closing the account ends monitoring without refund
--   Abroad        Privacy: processing outside India by our providers
--   Tidy          Cancellation 4 (no recurring plans) off; Privacy 3 title; Email 1 vs 8;
--                 the number-plate game, which no longer exists, removed
-- Every change is matched on the section's title and only while it is active.

-- ───────────────────────────────────────────────────────────── Terms ──
UPDATE terms_and_conditions SET description = $t$GaadiPe is an information service that retrieves vehicle documentation details — registration certificate (RC) and vehicle information, insurance validity, fitness, emission (PUCC), permits, FASTag status and traffic e-challans — from Government of India data sources, and presents them to you as a consolidated report on gaadipe.in and on the channels we offer, such as SMS, email, browser notifications and, where available, WhatsApp.$t$,
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Description of Service' AND is_active;

UPDATE terms_and_conditions SET description = $t$All vehicle particulars shown by GaadiPe come from Government of India records — VAHAN, the e-Challan system and NETC FASTag. They are received through the Unified Logistics Interface Platform (ULIP) and, when ULIP is slow or unavailable, through authorised third-party vehicle-data providers that draw on the same Government records. They are reproduced as received, from backup or replica databases that are synchronised periodically and may lag behind, or differ from, the live records held at the Regional Transport Office (RTO). GaadiPe does not create, alter, correct or independently verify this data. If any detail appears incorrect, outdated, incomplete or does not match your physical documents, please re-check directly with your local RTO or the concerned issuing authority.$t$,
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Accuracy of Information and Government Data Source' AND is_active;

UPDATE terms_and_conditions SET description = $t$GaadiPe is offered on our website gaadipe.in, where you check vehicles, sign in, buy reports and see your alerts, and we contact you by SMS, email and browser notifications on the devices where you allow them. Where GaadiPe is also offered on WhatsApp, it is only from the WhatsApp number published on gaadipe.in; a message claiming to be GaadiPe from any other number is not from us. If a channel is unavailable for a time, the website continues to serve you.$t$,
       title = 'GaadiPe on the Website, SMS, Email and WhatsApp',
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'GaadiPe on the Website, SMS and Email' AND is_active;

UPDATE terms_and_conditions
   SET description = replace(description, 'promotional SMS are sent only between 9 am and 9 pm', 'promotional SMS are sent only between 10 am and 9 pm'),
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Messages from GaadiPe — SMS, Email and Notifications' AND is_active
   AND description LIKE '%promotional SMS are sent only between 9 am and 9 pm%';

-- ──────────────────────────────────────────────────────────── Refund ──
INSERT INTO refund_policy (id, title, description, display_order, is_active, version, effective_from)
SELECT (SELECT coalesce(max(id), 0) + 1 FROM refund_policy), 'Closing Your Account',
       $t$You may close (deactivate) your account at any time. Closing it ends at once any monitoring still running, and the days remaining are not refunded; reports, renewals and fees already paid are not refunded either. Before your account is closed you are told this and asked to confirm. Invoices are kept as described in our Data Deletion Policy.$t$,
       12, true, '5.3', CURRENT_DATE
 WHERE NOT EXISTS (SELECT 1 FROM refund_policy WHERE title = 'Closing Your Account');

-- ─────────────────────────────────────────────────────────── Privacy ──
UPDATE privacy_policy SET title = 'Information Collected Automatically', version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Information We Do Not Receive' AND is_active;

UPDATE privacy_policy SET description = $t$Vehicle information is retrieved, when you ask for it, from Government of India records — VAHAN (registration), the e-Challan system and NETC FASTag — through the Unified Logistics Interface Platform (ULIP), operated under DPIIT, and, when ULIP is slow or unavailable, through authorised third-party vehicle-data providers that draw on the same Government records. We are a consumer of these records; we do not own, modify or maintain them.$t$,
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Vehicle Data and Its Sources' AND is_active;

UPDATE privacy_policy SET description = $t$We do not sell, rent or trade your personal data. It is shared only with the parties needed to run the service: our payment gateway for transactions; our SMS, email, notification and messaging providers (including WhatsApp / Meta where used) for communicating with you; the authorised vehicle-data providers for retrieving records; our hosting and infrastructure providers; and our analytics and advertising partners — Google (Google Analytics and Google Ads) and Meta (Facebook and Instagram) — which receive information about visits to gaadipe.in, such as the pages opened, the device and the advertisement that brought the visitor, to measure and improve our service and advertising. Your reports, payment details and sign-in codes are never shared with analytics or advertising partners.$t$,
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Data Sharing' AND is_active;

UPDATE privacy_policy SET description = $t$We keep data only as long as it is needed: your account details for as long as your account is open; the record of how you use the website for up to 180 days; vehicle records retrieved for you while your reports and monitoring need them, refreshed from the source when you check again; and payment, invoice and tax records for the period required under GST and income-tax law (currently up to 8 years), even after your account is closed. When a period ends, the data is deleted or anonymised.$t$,
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Data Retention' AND is_active;

UPDATE privacy_policy SET description = $t$You may request access to the personal data we hold about you, request correction of inaccurate data, request erasure of your data, withdraw consent, or nominate another person to exercise your rights in the event of your death or incapacity. Requests can be made by email to support@gaadipe.in or through any support channel we offer; we verify that a request comes from you before acting on it.$t$,
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Your Rights' AND is_active;

UPDATE privacy_policy SET description = $t$For any privacy question, complaint or request about your data, contact our Grievance Officer: Shivakumar Kirigeri, Proprietor, ServerPe App Solutions, The Orchard, HMT Watch Factory Main Road, HMT Estate, Jalahalli, Bengaluru – 560013, Karnataka; email support@gaadipe.in. We acknowledge every request within 48 hours and resolve it within 30 days, or sooner where the law requires. If you are not satisfied with our response, you may approach the Data Protection Board of India under the Digital Personal Data Protection Act, 2023.$t$,
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Grievance Redressal' AND is_active;

UPDATE privacy_policy SET description = $t$We may use anonymised and aggregated information — such as vehicle types, RTO references and counts, stripped of any personal detail — to measure and improve the service. This anonymised information cannot reasonably be used to identify you.$t$,
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'How We Improve GaadiPe' AND is_active;

-- The number-plate game no longer exists.
UPDATE privacy_policy SET is_active = false, modified_at = now()
 WHERE title IN ('Game Data', 'Number Plates in Our Game') AND is_active;

INSERT INTO privacy_policy (id, title, description, display_order, is_active, version, effective_from)
SELECT (SELECT coalesce(max(id), 0) + 1 FROM privacy_policy), 'Processing Outside India',
       $t$Some of our service providers — for example email, messaging, analytics, advertising and cloud services — may process data on servers outside India. Where this happens, it is only for the purposes in this policy, under those providers' own security commitments, and never to a country to which the Government of India has restricted such transfers.$t$,
       27, true, '5.3', CURRENT_DATE
 WHERE NOT EXISTS (SELECT 1 FROM privacy_policy WHERE title = 'Processing Outside India');

-- ─────────────────────────────────────────────────────────── Consent ──
UPDATE consent_policy SET description = $t$By starting free or paid monitoring for a vehicle, you authorise GaadiPe to periodically retrieve that vehicle's Government-sourced data and to send you related alerts — by browser notification, SMS, email or, where offered, WhatsApp — for the monitoring period. You can withdraw this at any time by asking us to stop, after which monitoring and alerts cease.$t$,
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Consent to Monitor Your Vehicle' AND is_active;

UPDATE consent_policy SET description = $t$Only if you opt in, we may send occasional promotional messages — offers and newsletters from GaadiPe — by SMS, email or, where offered, WhatsApp. You can opt out at any time in your Profile or by writing to support@gaadipe.in, without affecting service messages such as sign-in codes, receipts, reports and the alerts you have asked for.$t$,
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Consent to Marketing Messages' AND is_active;

-- ────────────────────────────────────────────────────── Cancellation ──
-- There is no auto-renewal (section 5 says so), so "cancel renewal" does not apply.
UPDATE cancellation_policy SET is_active = false, modified_at = now()
 WHERE title = 'Recurring Plans' AND is_active;

-- ───────────────────────────────────────────────────────────── Email ──
UPDATE email_policy
   SET description = replace(description, 'We do not send newsletters or third-party advertising.',
         'We never send third-party advertising; offers and newsletters from GaadiPe are sent only if you opt in, as described below.'),
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Emails We Send' AND is_active
   AND description LIKE '%We do not send newsletters or third-party advertising.%';

-- ───────────────────────────────────────────────────── Data deletion ──
UPDATE data_deletion_policy SET description = $t$On deletion we also end your active monitoring, remove any unredeemed rewards, and stop all alerts.$t$,
       title = 'Monitoring and Rewards', version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Monitoring and Game Data' AND is_active;

-- ───────────────────────────────────────────────────────── Liability ──
UPDATE liability_policy SET description = $t$All vehicle information originates from Government records, received through ULIP and, when ULIP is unavailable, through authorised third-party vehicle-data providers, and is served from backup or replica databases rather than the live RTO counter system. GaadiPe reproduces this data as received and makes no representation or warranty as to its accuracy, completeness, currency or fitness for any purpose. Errors, omissions, synchronisation delays or differences between these sources and the RTO's live record are outside our control, and we accept no liability arising from them.$t$,
       version = '5.3', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Third-Party Data Disclaimer' AND is_active;

UPDATE liability_policy SET is_active = false, modified_at = now()
 WHERE title = 'The Game' AND is_active;
