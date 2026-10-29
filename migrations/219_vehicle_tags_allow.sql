-- 219_vehicle_tags_allow.sql — GAADIPE TAG FOR CHOSEN NUMBERS BEFORE LAUNCH (user, 2026-10-29: "for me full fledged
-- working I need … not only me, it must work for all users who opt, but now do for me").
--
-- tag_allow_mobiles: while tag_enabled is OFF, these numbers (comma-separated, 10 digits) can make tags and be reached
-- through them exactly as everyone will after launch — on top of GaadiPe's own internal numbers. The owner's two:
-- 9886122415 (KA02EX1480, KA31N8147) and 9900970271 (KA32R8604). Edit it on the admin's GaadiPe Tag page or Settings.
INSERT INTO app_settings (key, value) VALUES ('tag_allow_mobiles', '9886122415,9900970271')
ON CONFLICT (key) DO NOTHING;
