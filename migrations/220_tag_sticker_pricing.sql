-- 220_tag_sticker_pricing.sql — STICKER PRICE (user, 2026-10-29: "2 mandatory, any vehicle, 149 inclusive of GST, 49 per
-- extra sticker"). One order is for one tag (one vehicle): at least tag_sticker_min (2) stickers for tag_sticker_base
-- (₹149), each more tag_sticker_extra (₹49), GST and delivery included anywhere in India; tag_remote_extra (₹0) can add
-- a surcharge for remote pincodes (North-East, J&K, Ladakh, islands). The older tag_zone_* rows stay but are not used.
ALTER TABLE tag_orders ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 2 CHECK (quantity BETWEEN 1 AND 20);

INSERT INTO app_settings (key, value) VALUES
  ('tag_sticker_min', '2'),
  ('tag_sticker_base', '149'),      -- ₹ for the minimum, GST + delivery included
  ('tag_sticker_extra', '49'),      -- ₹ for each sticker above the minimum
  ('tag_sticker_max', '10'),
  ('tag_remote_extra', '0')         -- ₹ added for remote pincodes (0 = same price everywhere)
ON CONFLICT (key) DO NOTHING;
