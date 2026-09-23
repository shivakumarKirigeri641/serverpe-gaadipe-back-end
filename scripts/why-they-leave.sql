-- scripts/why-they-leave.sql — what people actually do, and what a report costs.
--
-- Read-only. No personal data leaves in the output: mobiles are masked, and
-- nothing here prints a name, an email or an address.
--
-- Run it on the server:
--   psql "$DATABASE_URL" -f scripts/why-they-leave.sql
--
-- It answers three questions, in order:
--   A. Did they want anything beyond make and model?
--   B. Who are they, and where did they come from?
--   C. What does one report cost us?

\pset pager off
\timing off

\echo '==== A1. Every signed-in person: what they did, start to finish ===='
SELECT left(u.mobile, 4) || '****' || right(u.mobile, 2)          AS who,
       u.created_at::date                                          AS signed_up,
       (SELECT count(*)::int FROM user_vehicles uv WHERE uv.user_id = u.id)          AS plates,
       (SELECT coalesce(sum(uv.check_count), 0)::int FROM user_vehicles uv WHERE uv.user_id = u.id) AS checks,
       (SELECT count(*)::int FROM site_activity a
         WHERE a.user_id = u.id AND a.action = 'buy_open')         AS opened_buy,
       (SELECT count(*)::int FROM site_activity a
         WHERE a.user_id = u.id AND a.action = 'pay_start')         AS tapped_pay,
       (SELECT count(*)::int FROM payments p
         WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0) AS paid,
       (SELECT max(uv.last_checked_at)::date FROM user_vehicles uv WHERE uv.user_id = u.id) AS last_seen
  FROM users u
 WHERE u.deactivated_at IS NULL AND u.is_internal IS NOT TRUE
 ORDER BY signed_up;

\echo ''
\echo '==== A2. Did they come back to the same plate, or check it once? ===='
\echo '(check_count > 1 means they re-checked the SAME vehicle: a decision in progress)'
SELECT uv.check_count                          AS times_checked,
       count(*)::int                           AS how_many_plates,
       count(DISTINCT uv.user_id)::int         AS how_many_people
  FROM user_vehicles uv
  JOIN users u ON u.id = uv.user_id AND u.is_internal IS NOT TRUE
 GROUP BY uv.check_count
 ORDER BY uv.check_count;

\echo ''
\echo '==== A3. What they did AFTER seeing a free result ===='
\echo '(nothing at all = the free answer was the whole answer)'
WITH seen AS (
  SELECT a.session_id, a.id, a.created_at
    FROM site_activity a
   WHERE a.action IN ('view_vehicle', 'check')
), nxt AS (
  SELECT s.session_id, s.created_at AS saw_at,
         (SELECT a2.action FROM site_activity a2
           WHERE a2.session_id = s.session_id AND a2.id > s.id AND a2.action IS NOT NULL
           ORDER BY a2.id LIMIT 1)      AS did_next,
         (SELECT a2.created_at FROM site_activity a2
           WHERE a2.session_id = s.session_id AND a2.id > s.id
           ORDER BY a2.id LIMIT 1)      AS next_at
    FROM seen s
)
SELECT coalesce(did_next, '(nothing — they left)')                                   AS after_the_free_result,
       count(*)::int                                                                  AS times,
       round(avg(extract(epoch FROM (next_at - saw_at)))::numeric, 1)                AS avg_seconds_before_it
  FROM nxt
 GROUP BY 1
 ORDER BY times DESC;

\echo ''
\echo '==== A4. How long they stayed after the result, before doing anything else ===='
\echo '(under ~10s = never considered buying; 30s+ = considered it and said no)'
WITH seen AS (
  SELECT a.session_id, a.id, a.created_at,
         (SELECT max(a2.created_at) FROM site_activity a2 WHERE a2.session_id = a.session_id) AS last_at
    FROM site_activity a
   WHERE a.action IN ('view_vehicle', 'check')
)
SELECT CASE
         WHEN extract(epoch FROM (last_at - created_at)) < 5   THEN 'a. under 5s'
         WHEN extract(epoch FROM (last_at - created_at)) < 15  THEN 'b. 5-15s'
         WHEN extract(epoch FROM (last_at - created_at)) < 45  THEN 'c. 15-45s'
         WHEN extract(epoch FROM (last_at - created_at)) < 180 THEN 'd. 45s-3min'
         ELSE                                                       'e. over 3 min'
       END                        AS stayed,
       count(*)::int              AS results_viewed
  FROM seen
 GROUP BY 1 ORDER BY 1;

\echo ''
\echo '==== A5. Which pages they visited at all ===='
SELECT a.page, count(*)::int AS views, count(DISTINCT a.session_id)::int AS people
  FROM site_activity a
 WHERE a.page IS NOT NULL
 GROUP BY a.page ORDER BY views DESC LIMIT 20;

\echo ''
\echo '==== B1. Where they came from ===='
SELECT CASE
         WHEN s.referrer ILIKE '%google%'    THEN 'Google'
         WHEN s.referrer ILIKE '%facebook%' OR s.referrer ILIKE '%instagram%' THEN 'Meta'
         WHEN s.page ILIKE '%gclid%'         THEN 'Google Ads (gclid)'
         WHEN s.page ILIKE '%utm_%'          THEN 'campaign link'
         WHEN s.referrer IS NULL OR s.referrer = '' THEN 'typed / direct'
         ELSE s.referrer
       END                                  AS came_from,
       count(*)::int                        AS sign_in_steps,
       count(DISTINCT s.mobile)::int        AS people
  FROM site_sign_ins s
 GROUP BY 1 ORDER BY sign_in_steps DESC LIMIT 20;

\echo ''
\echo '==== B2. Phone or desktop, and which browser ===='
SELECT coalesce(s.device_type, 'unknown') AS device, coalesce(s.os, '—') AS os,
       count(DISTINCT s.mobile)::int      AS people
  FROM site_sign_ins s WHERE s.event = 'signed_in'
 GROUP BY 1, 2 ORDER BY people DESC LIMIT 10;

\echo ''
\echo '==== B3. What kind of vehicles they check ===='
SELECT coalesce(v.vehicle_class, 'unknown') AS class, count(DISTINCT uv.vehicle_id)::int AS plates
  FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
 GROUP BY 1 ORDER BY plates DESC LIMIT 15;

\echo ''
\echo '==== C1. What one lookup costs, by dataset ===='
SELECT c.dataset,
       count(*)::int                                            AS calls,
       count(*) FILTER (WHERE c.ok)::int                        AS succeeded,
       count(*) FILTER (WHERE c.cache_hit)::int                 AS from_cache,
       round(sum(c.cost_paise) / 100.0, 2)                      AS total_rupees,
       round(avg(c.cost_paise) FILTER (WHERE c.ok AND NOT c.cache_hit) / 100.0, 4) AS avg_rupees_per_live_call
  FROM api_calls c
 GROUP BY c.dataset ORDER BY calls DESC;

\echo ''
\echo '==== C2. What a full report costs us in lookups ===='
SELECT round(sum(c.cost_paise) / 100.0, 2)                      AS rupees_spent_all_time,
       count(DISTINCT c.reg_no)::int                            AS distinct_plates,
       round((sum(c.cost_paise) / 100.0)
             / nullif(count(DISTINCT c.reg_no), 0), 2)          AS rupees_per_plate
  FROM api_calls c
 WHERE c.ok AND NOT c.cache_hit;

\echo ''
\echo '==== C3. Why lookups failed, if any did ===='
SELECT coalesce(c.outcome, 'ok') AS outcome, coalesce(c.error_code, '—') AS code,
       count(*)::int             AS times
  FROM api_calls c
 WHERE NOT c.ok
 GROUP BY 1, 2 ORDER BY times DESC LIMIT 15;
