-- 093_rtos_from_records.sql — RTO codes the list (092) lacks, from vehicle
-- records already looked up (user, 2026-10-01). From now on store.learnRto
-- adds them as they appear.
--
-- A record names the office the vehicle is registered at NOW, which is not
-- always the office of its plate's code (a KA01 car moved to Rajajinagar says
-- "Bengaluru West"). So it never overrides a listed office: it only names a
-- code the list does not have, using the name most of that code's vehicles give.
-- The plate's RTO is read as the Where page reads it: KA01AB… → KA01, DL1C… →
-- DL01, old state codes folded into today's. Bharat-series (BH) plates have no
-- RTO and are left out.

WITH named AS (
  SELECT upper(regexp_replace(v.reg_no, '[^A-Za-z0-9]', '', 'g')) AS reg,
         regexp_replace(s.data->>'registered_at', '\s+', ' ', 'g') AS name
    FROM vehicle_snapshots s JOIN vehicles v ON v.id = s.vehicle_id
   WHERE s.dataset = 'rc' AND coalesce(s.data->>'registered_at', '') <> ''
), coded AS (
  SELECT CASE WHEN reg ~ '^[A-Z]{2}[0-9]{2}' THEN left(reg, 4)
              WHEN reg ~ '^[A-Z]{2}[0-9][A-Z]' THEN left(reg, 2) || '0' || substring(reg from 3 for 1)
         END AS raw, name
    FROM named
), folded AS (
  SELECT CASE left(raw, 2) WHEN 'TG' THEN 'TS' WHEN 'OR' THEN 'OD' WHEN 'UA' THEN 'UK'
                           WHEN 'CT' THEN 'CG' WHEN 'DN' THEN 'DD' ELSE left(raw, 2) END
         || substring(raw from 3) AS code, name
    FROM coded WHERE raw IS NOT NULL AND raw NOT LIKE 'BH%'
), votes AS (
  SELECT code, name, count(*) AS n FROM folded GROUP BY 1, 2
)
INSERT INTO rtos (code, state_code, vahan_name, vahan_at, source)
SELECT DISTINCT ON (code) code, left(code, 2), left(name, 120), now(), 'vahan'
  FROM votes ORDER BY code, n DESC
ON CONFLICT (code) DO NOTHING;
