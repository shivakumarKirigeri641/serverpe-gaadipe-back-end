/**
 * src/admin/catalogue.js — EVERY VEHICLE, EVERY DETAIL (user, 2026-10-25: "distinct vehicle details — one
 * separate panel to show make, model, variant, type, fuel and all vehicle details from the DB, only for me").
 *
 * One row per vehicle GaadiPe has seen, from its richest RC record (vehicle_snapshots, dataset 'rc': a full
 * VAHAN / Way2API / IDSPay answer beats eChallan.app's four fields, then the newest). The panel searches,
 * filters, groups and exports in the browser, so this sends everything at once (up to LIMIT rows).
 *
 * OWNER ONLY: the route needs 'vehicles.catalogue', which only the owner role has (admin/auth.js).
 * The vehicle, not the person: owner name, address, chassis and engine numbers are never sent.
 */
const db = require('../db');

const LIMIT = 20000;

/* No separate variant comes back from any provider (Way2API's variant is always null): the RC's model
   usually carries it ("SELTOS D1.5 6AT HTX PLUS"), so the model is shown whole. */
async function list() {
  const { rows } = await db.query(
    `SELECT v.reg_no,
            coalesce(nullif(s.data->>'maker', ''), v.maker)                 AS maker,
            coalesce(nullif(s.data->>'model', ''), v.model)                 AS model,
            coalesce(nullif(s.data->>'fuel', ''), v.fuel)                   AS fuel,
            coalesce(nullif(s.data->>'vehicle_class', ''), v.vehicle_class) AS vehicle_class,
            s.data->>'vehicle_category' AS vehicle_category, s.data->>'body_type' AS body_type,
            s.data->>'colour' AS colour, s.data->>'norms' AS norms, s.data->>'cubic_capacity' AS cc,
            s.data->>'cylinders' AS cylinders, s.data->>'seats' AS seats, s.data->>'wheelbase' AS wheelbase,
            s.data->>'unladen_weight' AS unladen_weight, s.data->>'gross_weight' AS gross_weight,
            s.data->>'manufactured' AS manufactured, s.data->>'owner_category' AS owner_category,
            s.data->>'owner_type' AS owner_type, s.data->>'registered_at' AS registered_at,
            s.data->>'state_code' AS state_code, s.data->>'insurance_company' AS insurance_company,
            s.data->>'permit_type' AS permit_type, s.data->>'noc_details' AS noc_details,
            coalesce(nullif(s.data->>'status', ''), v.rc_status)            AS rc_status,
            ${['reg_date', 'reg_upto', 'insurance_upto', 'pucc_upto', 'fitness_upto', 'tax_upto', 'permit_upto']
              .map((c) => `to_char(v.${c}, 'YYYY-MM-DD') AS ${c}`).join(', ')},
            v.owner_serial, v.financer, v.blacklist_status,
            s.source, s.fetched_at, v.first_seen_at, v.last_seen_at,
            (SELECT count(DISTINCT uv.user_id) FROM user_vehicles uv WHERE uv.vehicle_id = v.id)::int AS customers,
            EXISTS (SELECT 1 FROM vehicle_reports r WHERE r.vehicle_id = v.id)                       AS reported
       FROM vehicles v
       LEFT JOIN LATERAL (
         SELECT data, source, fetched_at FROM vehicle_snapshots
          WHERE vehicle_id = v.id AND dataset = 'rc'
          ORDER BY (data ? 'body_type') DESC, fetched_at DESC LIMIT 1) s ON true
      ORDER BY v.last_seen_at DESC NULLS LAST
      LIMIT ${LIMIT}`);
  const { n } = await db.one('SELECT count(*)::int AS n FROM vehicles');
  return { total: n, capped: n > LIMIT, rows };
}

module.exports = { list };
