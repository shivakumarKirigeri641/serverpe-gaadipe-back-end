-- 142_free_check_before_sign_in.sql (user, 2026-10-08: "200+ visitors, no sign-in —
-- show 1 vehicle per device or IP: make, model and fuel, then 'Get full report ₹19',
-- then sign in"; the visitor agrees to the Terms, policies and consent first;
-- variant hidden; every detail of the check recorded).
--
-- WHAT A VISITOR WHO HAS NOT SIGNED IN GETS: one vehicle a day — per browser AND
-- per network address, whichever is used first — after tapping "Agree & check".
-- Shown: make, the model name with its variant hidden, and fuel. Nothing else.
-- Looked up from the saved record or ULIP's RC only: no challan call, no paid
-- backup, no eChallan.app. Signed-in customers are unchanged (basic view, then
-- the ₹19 report).

/* ---------------------------------------------------------- the audit record */
-- One row per attempt, refused ones included, with everything known about who
-- asked and what they agreed to. Linked to the account if they sign in later
-- on the same browser.
CREATE TABLE IF NOT EXISTS anon_checks (
  id             bigserial PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  reg_no         text,
  outcome        text        NOT NULL,              -- shown | not_found | failed | refused
  refusal        text,                              -- why it was refused (limit, guard, no device, consent…)
  data_source    text,                              -- saved record | ULIP
  latency_ms     integer,
  shown          jsonb,                             -- exactly what was put on the screen
  -- who
  device_id      text,
  visitor_id     text,
  session_id     text,
  ip             text,
  ip_key         text,                              -- what the per-network limit counts: the IPv4 address, or the IPv6 /64 block
  ip_chain       text,
  user_agent     text,
  device         jsonb       NOT NULL DEFAULT '{}', -- type, vendor, model, OS, browser, screen, time zone, languages, network…
  place          jsonb       NOT NULL DEFAULT '{}', -- city, region, country (approximate, from the IP)
  referrer       text,
  page           text,
  source         text,                              -- google_ads, meta_ads… (the visit's first source)
  campaign       text,
  -- what they agreed to
  consent        jsonb,                             -- agreed, method, words shown, language, policy versions, lawful purpose
  -- later
  user_id        bigint      REFERENCES users(id) ON DELETE SET NULL,
  linked_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_anon_checks_day_device ON anon_checks (device_id, created_at);
ALTER TABLE anon_checks ADD COLUMN IF NOT EXISTS ip_key text;
CREATE INDEX IF NOT EXISTS idx_anon_checks_day_ip ON anon_checks (ip_key, created_at);
CREATE INDEX IF NOT EXISTS idx_anon_checks_created ON anon_checks (created_at DESC);

/* ------------------------------------------------------------------ switches */
INSERT INTO app_settings (key, value) VALUES
  ('check_sign_in_required', 'false'),        -- the free check before sign-in is ON
  ('chat_anon_checks_per_day', '1'),          -- per browser (device id), per day
  ('chat_anon_checks_per_day_ip', '1'),       -- per network address, per day
  ('chat_anon_checks_per_hour', '60')         -- the whole site, per hour — a flood stops here
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now();

/* -------------------------------------------------------- terms and policies */
-- Acceptance of Terms 1.2: agreeing before a free check is acceptance too.
UPDATE terms_and_conditions
   SET description = 'By using gaadipe.in, or any GaadiPe service or communication channel (such as SMS or email), you agree to be bound by these Terms & Conditions. '
         || 'Before a free vehicle check without signing in, the website asks you to agree to GaadiPe’s Terms of use, Privacy policy and Refund policy and to confirm that you are checking the vehicle for a lawful purpose; tapping “Agree & check” is your acceptance. '
         || 'When you sign in, the sign-in screen tells you: “By signing in, you agree to GaadiPe’s Terms of use, Privacy policy and Refund policy.” Signing in with your mobile number and the one-time code we send you is your acceptance of these Terms, the Privacy policy and the Refund policy, as they stand at that time — no separate box needs to be ticked. '
         || 'We keep a record of each acceptance: the date and time, the versions of the policies in force, and the device and network address it was given from. '
         || 'GaadiPe is operated by ServerPe App Solutions (GSTIN 29BSMPK7696H1ZT). If you do not agree with any part of these Terms, please do not use the service.',
       version = '1.2', effective_from = CURRENT_DATE, modified_at = now()
 WHERE title = 'Acceptance of Terms';

INSERT INTO terms_and_conditions (id, title, description, display_order, is_active, version, effective_from)
VALUES (30, 'Free Check Before Signing In',
  'Without signing in, you may check one vehicle a day from a browser and network address. Before the check you are asked to agree to these Terms, the Privacy policy and the Refund policy, and to confirm that you are checking the vehicle for a lawful purpose — for example because you are buying it, or it is your own. '
  || 'The free check shows only the vehicle’s make, its model name (without the variant) and its fuel type, as recorded in the Government’s VAHAN records. The full model and variant are shown after you sign in. It does not show the owner, the address, any document dates, challans, loan or any other detail; those are in the full report. '
  || 'Each free check is recorded with the vehicle number, the date and time, your device, browser and network details, and what you agreed to, so that the service can be protected from misuse. Automated checks, repeated attempts to get round the daily limit, or any use listed under Prohibited Use may be blocked.',
  30, true, '1.0', CURRENT_DATE)
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, version = EXCLUDED.version,
  effective_from = EXCLUDED.effective_from, is_active = true, modified_at = now();

INSERT INTO privacy_policy (id, title, description, display_order, is_active, version, effective_from)
VALUES (26, 'Free Vehicle Checks Before Signing In',
  'When you check a vehicle without signing in, we record: the vehicle number you entered; the date and time; a random identifier kept in your browser (device id), your visit and session identifiers; your IP address and approximate location derived from it (city, state, country); your browser’s user agent and the device, operating system, browser, screen, time zone, language and network type it reports; the page you came from and the advertisement or link that brought you; and your agreement to our Terms, Privacy policy and Refund policy, with the exact words shown and the policy versions. '
  || 'We use this record only to run the one-free-check-a-day limit, to protect the service and the Government data sources from misuse and automated scraping, to keep a record of your consent, and to understand how visitors use GaadiPe. It is not sold or shared, except as required by law. If you later sign in on the same browser, the record is linked to your account. '
  || 'It is kept only as long as needed for these purposes and for legal record-keeping. You may ask for it to be deleted by writing to support@gaadipe.in.',
  26, true, '1.0', CURRENT_DATE)
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, version = EXCLUDED.version,
  effective_from = EXCLUDED.effective_from, is_active = true, modified_at = now();

UPDATE consent_policy
   SET description = 'By sending or entering a vehicle registration number — including tapping “Agree & check” for a free check before signing in — you request and consent to GaadiPe retrieving that vehicle’s records from Government of India data sources on your behalf, and you confirm that you are doing so for a lawful purpose, such as buying the vehicle or because it is your own.',
       version = '1.1', effective_from = CURRENT_DATE, modified_at = now()
 WHERE id = 2;
