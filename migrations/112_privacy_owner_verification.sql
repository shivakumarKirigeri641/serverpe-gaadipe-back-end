-- 112_privacy_owner_verification.sql — two NEW privacy sections for owner
-- verification (user, 2026-10-04): the RC photo, and telling a verified owner
-- when their vehicle is checked. Existing text is not changed. Version 1.3
-- stays below the Terms' 4.0, so nobody is asked to agree again.

INSERT INTO privacy_policy (id, title, description, display_order, is_active, version, effective_from)
SELECT m.nid, 'Proving You Own a Vehicle',
       'If you choose to prove that you own a vehicle, you send us a photo or PDF of its registration certificate (RC) on WhatsApp. We use it only to check that you are the owner, by comparing it with the Government record. It is kept encrypted, seen only by GaadiPe, never shared, and deleted as soon as we decide — whether we approve it or not. We keep only the result (verified or not) and the date. You may cover your address, photograph and date of birth before sending it.',
       m.nord, true, '1.3', CURRENT_DATE
  FROM (SELECT coalesce(max(id), 0) + 1 AS nid, coalesce(max(display_order), 0) + 1 AS nord FROM privacy_policy) m
 WHERE NOT EXISTS (SELECT 1 FROM privacy_policy WHERE title = 'Proving You Own a Vehicle');

INSERT INTO privacy_policy (id, title, description, display_order, is_active, version, effective_from)
SELECT m.nid, 'When a Verified Owner''s Vehicle Is Checked',
       'If a vehicle you check has a verified owner on GaadiPe, that owner may be told that it was checked, when, and the last four digits of your mobile number — never your full number, name or anything else. You are told this on the result before it happens. If you are a verified owner, you can stop these alerts at any time with the "Stop these alerts" button, or hide your vehicle from other people''s checks.',
       m.nord, true, '1.3', CURRENT_DATE
  FROM (SELECT coalesce(max(id), 0) + 1 AS nid, coalesce(max(display_order), 0) + 1 AS nord FROM privacy_policy) m
 WHERE NOT EXISTS (SELECT 1 FROM privacy_policy WHERE title = 'When a Verified Owner''s Vehicle Is Checked');
