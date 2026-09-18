-- 029_vehicle_reg_upto.sql — registration validity, as a column like the others.
--
-- Every other expiry date on a vehicle (insurance, PUC, fitness, tax, permit)
-- was lifted out of the RC snapshot into a column; registration was not. So a
-- lapsed registration showed on the vehicle page, which reads the snapshot,
-- and was missing from "My vehicles", which reads the columns — the same
-- vehicle telling the customer two different things.
--
-- Backfilled from the stored RC snapshot, so vehicles already checked are
-- right immediately rather than after their next lookup. Safe to run twice.

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS reg_upto date;

UPDATE vehicles v
   SET reg_upto = (s.data->>'reg_upto')::date
  FROM vehicle_snapshots s
 WHERE s.vehicle_id = v.id
   AND s.dataset = 'rc'
   AND v.reg_upto IS NULL
   AND s.data->>'reg_upto' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
