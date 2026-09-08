/**
 * src/ulip/echallan.js
 * ---------------------------------------------------------------------------
 * e-Challan lookup (ECHALLAN/01).
 *
 * Mind the casing: this dataset takes `vehicleNumber` while VAHAN and FASTAG
 * take `vehiclenumber`. Sending the wrong one earns a 400 that reads like a
 * format problem and sends you looking in entirely the wrong place.
 *
 * A clean vehicle is a SUCCESS, not an error:
 *   { data: { Pending_data: [], Disposed_data: [] }, status: "200",
 *     message: "Record  finds successfully" }
 *
 * And a vehicle with no record at all comes back as code 305, "No Records
 * Found!", still wrapped in responseStatus "SUCCESS". Both mean "nothing owed"
 * — which for a buyer is the answer they were hoping for. Neither may ever be
 * reported as a failure.
 * ---------------------------------------------------------------------------
 */

const { post, OUTCOME } = require('./client');

const blank = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};
const paise = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/* ULIP has not been consistent about challan field names across states, so
   each value is read from a list of candidates and anything unrecognised is
   preserved rather than dropped — a field we do not understand today may be
   the one a customer asks about tomorrow. */
const pick = (row, names) => {
  for (const n of names) {
    if (row[n] != null && String(row[n]).trim() !== '') return row[n];
  }
  return null;
};

const KNOWN = new Set([
  'challan_no','challanNo','challan_number','challan_date','challanDate',
  'amount','fine_imposed','challan_status','status','offence_details','offence',
  'violation','accused_name','court_status','challan_place','state',
]);

function mapChallan(row, state) {
  const extra = {};
  for (const [k, v] of Object.entries(row)) {
    if (!KNOWN.has(k) && v != null && String(v).trim() !== '') extra[k] = v;
  }
  return {
    challan_no: blank(pick(row, ['challan_no','challanNo','challan_number'])),
    challan_date: blank(pick(row, ['challan_date','challanDate'])),
    amount_paise: paise(pick(row, ['amount','fine_imposed'])),
    status: blank(pick(row, ['challan_status','status'])) || state,
    offence: blank(pick(row, ['offence_details','offence','violation'])),
    place: blank(pick(row, ['challan_place'])),
    court_status: blank(pick(row, ['court_status'])),
    state,
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

const empty = () => ({
  pending: [], disposed: [],
  pending_count: 0, disposed_count: 0,
  pending_amount_paise: 0, disposed_amount_paise: 0,
  checked_at: new Date().toISOString(),
});

/** Returns { ok, data, calls } — zero challans is a successful answer. */
async function fetchChallans(regNo) {
  const r = await post('ECHALLAN/01', { vehicleNumber: regNo });
  const calls = [{ path: r.path, outcome: r.outcome, code: r.code, ms: r.durationMs }];

  // 305 "No Records Found!" — the vehicle simply has no challans on record.
  if (r.outcome === OUTCOME.NOT_FOUND) {
    return { ok: true, data: empty(), noRecords: true, calls };
  }
  if (r.outcome !== OUTCOME.FOUND) {
    return { ok: false, data: null, code: r.code, error: r.message || 'Challan lookup failed', calls };
  }

  const payload = r.payload || {};

  // Some responses carry the 305 shape in the payload rather than as a
  // dataset error, so check here too.
  if (String(payload.code ?? '') === '305') {
    return { ok: true, data: empty(), noRecords: true, calls };
  }

  const inner = payload.data || {};
  const pending = (Array.isArray(inner.Pending_data) ? inner.Pending_data : []).map(x => mapChallan(x, 'pending'));
  const disposed = (Array.isArray(inner.Disposed_data) ? inner.Disposed_data : []).map(x => mapChallan(x, 'disposed'));
  const sum = (rows) => rows.reduce((t, c) => t + (c.amount_paise || 0), 0);

  return {
    ok: true,
    data: {
      pending, disposed,
      pending_count: pending.length,
      disposed_count: disposed.length,
      pending_amount_paise: sum(pending),
      disposed_amount_paise: sum(disposed),
      checked_at: new Date().toISOString(),
    },
    calls,
  };
}

module.exports = { fetchChallans, mapChallan };
