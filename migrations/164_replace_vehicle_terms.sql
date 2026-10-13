-- 164_replace_vehicle_terms.sql (user, 2026-10-13: "Terms and Refund policy must mention
-- Replace vehicle — yes"). Replace vehicle (migration 163, pay/replace.js) in the Terms
-- and the Refund policy. Version 5.2 is above every policy in force (5.1), so the bot
-- and the site ask everyone to agree once more (flow.js policyVersion).

INSERT INTO terms_and_conditions (id, title, description, display_order, is_active, version, effective_from)
SELECT (SELECT coalesce(max(id), 0) + 1 FROM terms_and_conditions), 'Replace Vehicle',
       'While paid monitoring for a vehicle is running, you may replace that vehicle with another one once, within 7 days '
    || 'of buying its full report or its renewal, for Rs.9 plus GST (Rs.10.62 in all). The monitoring then continues on '
    || 'the new vehicle until the same end date; no days are added. The vehicle replaced leaves your list and its alerts '
    || 'stop; its report and invoice stay available for their normal period. Reports are not transferable: the full report '
    || 'of the new vehicle is not included and is bought separately. Before paying you are shown the new vehicle''s number, '
    || 'make and model; the fee is for the vehicle you confirm there.',
       31, true, '5.2', CURRENT_DATE
 WHERE NOT EXISTS (SELECT 1 FROM terms_and_conditions WHERE title = 'Replace Vehicle');

INSERT INTO refund_policy (id, title, description, display_order, is_active, version, effective_from)
SELECT (SELECT coalesce(max(id), 0) + 1 FROM refund_policy), 'Replace Vehicle Fee',
       'The Rs.9 plus GST fee to replace a vehicle is not refundable once the vehicle has been replaced, including where '
    || 'a vehicle number other than the one you meant was entered. If the amount is debited but the payment does not '
    || 'complete, it is reversed as described under Failed or Pending Payments.',
       11, true, '5.2', CURRENT_DATE
 WHERE NOT EXISTS (SELECT 1 FROM refund_policy WHERE title = 'Replace Vehicle Fee');
