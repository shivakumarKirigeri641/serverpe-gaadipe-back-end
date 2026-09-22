-- 050_free_view_detail.sql — how much the FREE check gives away (user, 2026-09-22).
--
-- Customers were checking a vehicle, reading "Registration, Road tax expired ·
-- 1 pending challan", and leaving: the free answer was the answer. This setting
-- decides what the free view says about what is wrong:
--
--   labels  which documents lapsed, by name, and the challan count (until now)
--   count   only HOW MANY things need attention — not which, not how many challans
--   none    the vehicle's identity only (maker, model, fuel, class)
--
-- It applies everywhere the free view appears: the vehicle page, My vehicles,
-- and the every-few-days email. Change it in Settings and watch the funnel
-- (scripts/funnel.js); nothing needs a deploy.

INSERT INTO app_settings (key, value) VALUES ('free_view_detail', 'count')
ON CONFLICT (key) DO NOTHING;
