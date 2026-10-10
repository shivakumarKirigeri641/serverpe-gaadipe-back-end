-- 151_agree_by_entering_number.sql (user, 2026-10-10: "say that by entering a
-- vehicle number you agree to the terms — no need to have a button"). The free
-- check before sign-in no longer has an "Agree & check" card: the line under the
-- chat's welcome says "By entering a vehicle number, you agree to GaadiPe's Terms
-- of use, Privacy policy and Refund policy", and the check runs when a number is
-- entered. Terms clause 30 says so.
UPDATE terms_and_conditions
   SET description = 'Without signing in, you may check up to three vehicles a day from a browser and network address. '
         || 'By entering a vehicle number you agree to these Terms, the Privacy policy and the Refund policy, '
         || 'including that you check vehicles only for a lawful purpose as described under Permitted Use — for example because you are buying the vehicle, or it is your own. '
         || 'The free check shows the vehicle''s make, model and variant, class and fuel, the registered owner''s name masked as in the Government''s records, and the RTO it is registered at. '
         || 'After signing in you also see the validity dates of its documents and how many challans are pending; '
         || 'the loan, blacklist and NOC status, each challan in detail and the other particulars are in the full report. '
         || 'Each free check is recorded with the vehicle number, the date and time, and your device and network details, as described in our Privacy policy, '
         || 'so that the service can be protected from misuse. Automated checks, repeated attempts to get round the daily limit, '
         || 'or any use listed under Prohibited Use may be blocked.',
       version = '1.2', effective_from = CURRENT_DATE, modified_at = now()
 WHERE id = 30;
