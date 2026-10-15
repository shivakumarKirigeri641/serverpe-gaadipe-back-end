-- 190_watch_period_start.sql (user, 2026-10-15: "monitoring messages once in 3 days, as per the
-- user's paid date, right?"). The 3-day status cycle and its day-28 end counted from the watch
-- row's created_at — the FIRST payment. A renewal or a second purchase for the same vehicle
-- reuses that row (ON CONFLICT in pay/billing.js), so its second period got no routine updates
-- at all. Each paid period now starts its own cycle: period_started_at, set on every payment.
ALTER TABLE watches ADD COLUMN IF NOT EXISTS period_started_at timestamptz NOT NULL DEFAULT now();

-- Existing watches: the latest paid payment for that customer and vehicle, else when the watch began.
UPDATE watches w
   SET period_started_at = coalesce(
         (SELECT max(p.paid_at) FROM payments p
           WHERE p.user_id = w.user_id AND p.status = 'paid' AND p.paid_at IS NOT NULL
             AND p.raw ? 'vehicle_id' AND p.raw->>'vehicle_id' = w.vehicle_id::text),
         w.created_at);
