-- 221_tag_orders_delhivery.sql — STICKERS SHIPPED BY DELHIVERY'S API (user, 2026-10-29: "I need to call the API, not
-- manual booking"; src/ship/delhivery.js). A paid order is booked from the admin (the waybill is the tracking number),
-- its label printed, a pickup requested, and its tracking refreshed; 'delivered' once Delhivery says so.
ALTER TABLE tag_orders ADD COLUMN IF NOT EXISTS ship_city text;
ALTER TABLE tag_orders ADD COLUMN IF NOT EXISTS ship_state text;
ALTER TABLE tag_orders ADD COLUMN IF NOT EXISTS waybill text;
ALTER TABLE tag_orders ADD COLUMN IF NOT EXISTS booked_at timestamptz;
ALTER TABLE tag_orders ADD COLUMN IF NOT EXISTS pickup_id text;
ALTER TABLE tag_orders ADD COLUMN IF NOT EXISTS ship_status text;
ALTER TABLE tag_orders ADD COLUMN IF NOT EXISTS ship_status_at timestamptz;
ALTER TABLE tag_orders ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE tag_orders ADD COLUMN IF NOT EXISTS ship_error text;

ALTER TABLE tag_orders DROP CONSTRAINT IF EXISTS tag_orders_status_check;
ALTER TABLE tag_orders ADD CONSTRAINT tag_orders_status_check
  CHECK (status IN ('created', 'paid', 'dispatched', 'delivered', 'cancelled'));
