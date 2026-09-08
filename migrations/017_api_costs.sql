-- 017_api_costs.sql — what an upstream call costs, per dataset.
--
-- ULIP is free today. That is a fact about 2026, not a property of the product,
-- and the day it changes three questions become urgent at once:
--
--   what does one customer cost us per cycle?
--   which vehicles are expensive to watch?
--   is Rs.39 still a profitable renewal?
--
-- None of those can be answered backwards. Cost has to be recorded against
-- every call from the beginning, so the history is already there when the price
-- stops being zero. That is why api_calls.cost_paise has existed since 002 —
-- but nothing was writing to the table at all, so there was no history to
-- price. This migration adds the rates; the code starts recording the calls.
--
-- Rates are per DATASET rather than one flat number, because ULIP will not
-- price them the same: VAHAN is one lookup, ECHALLAN can return hundreds of
-- rows, and FASTAG is two separate endpoints. A single "cost per call" would
-- hide exactly the difference that matters when deciding what to fetch and how
-- often.
--
-- Everything is zero now. Setting a real rate is one UPDATE, and from that
-- moment every call carries its cost.

BEGIN;

INSERT INTO app_settings (key, value) VALUES
  ('ulip_cost_paise_vahan',   '0'),
  ('ulip_cost_paise_challan', '0'),
  ('ulip_cost_paise_fastag',  '0'),
  -- A cache hit costs nothing upstream, but recording it is what makes the
  -- hit-rate visible — and the hit-rate is the whole defence against a per-call
  -- price. Kept separate so the day it is not free (a paid cache tier, say)
  -- there is somewhere to put it.
  ('cache_hit_cost_paise',    '0'),
  -- Meta charges per conversation, not per message. Recorded alongside so the
  -- true cost of a watched vehicle is one query rather than two systems.
  ('whatsapp_cost_paise_utility',   '12'),
  ('whatsapp_cost_paise_marketing', '78')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Costs are always asked about over a period, and almost always per customer
-- or per vehicle.
CREATE INDEX IF NOT EXISTS idx_api_calls_when ON api_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_calls_user ON api_calls (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_calls_vehicle ON api_calls (vehicle_id, created_at DESC);

COMMIT;
