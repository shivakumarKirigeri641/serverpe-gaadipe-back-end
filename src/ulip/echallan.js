/**
 * src/ulip/echallan.js
 * ---------------------------------------------------------------------------
 * e-Challan lookup (ECHALLAN/01).
 *
 * Mind the casing: this dataset takes `vehicleNumber` while VAHAN and FASTAG
 * take `vehiclenumber`. Sending the wrong one earns a 400 that reads like a
 * format problem and sends you looking in entirely the wrong place.
 *
 * A clean vehicle is a SUCCESS, not an error — empty Pending_data and
 * Disposed_data arrays — and a vehicle with no record at all comes back as
 * code 305, "No Records Found!", still inside responseStatus "SUCCESS". Both
 * mean "nothing owed", which for a buyer is the answer they were hoping for.
 * Neither may ever be reported as a failure.
 *
 * SHAPES ARE NOT STABLE. ULIP relays whatever each state's system sends, so
 * field names differ between states and a value that is a string for one is an
 * object for another — a real Puducherry challan arrived with `offence` as an
 * object and its date under `challan_date_time`. Everything here is therefore
 * read defensively: values are coerced to text whatever their shape, dates are
 * looked for under several names, and anything unrecognised is preserved under
 * `extra` rather than dropped.
 *
 * The output is flat, typed and predictable, because a front-end should never
 * have to deal with any of the above.
 * ---------------------------------------------------------------------------
 */

const { post, OUTCOME } = require('./client');

const blank = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

/**
 * Coerce any shape to readable text.
 * A field may arrive as a string, an object ({ code, description, … }), or an
 * array of either. `String(obj)` giving "[object Object]" in a customer-facing
 * report is exactly what this exists to prevent.
 */
function text(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return blank(v);
  if (Array.isArray(v)) {
    const parts = v.map(text).filter(Boolean);
    return parts.length ? parts.join('; ') : null;
  }
  if (typeof v === 'object') {
    // Prefer a human-readable field if the object carries one.
    for (const k of ['description', 'desc', 'name', 'text', 'offence', 'violation',
                     'offence_name', 'section', 'title', 'value']) {
      const hit = blank(v[k]);
      if (hit) return hit;
    }
    // Otherwise join whatever scalar values it holds, so nothing is lost.
    const parts = Object.values(v).map(x => (typeof x === 'object' ? null : blank(x))).filter(Boolean);
    return parts.length ? parts.join(' — ') : null;
  }
  return blank(v);
}

/** Rupees (or paise-looking values) to integer paise. */
function paise(v) {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** First non-empty value among several candidate field names. */
const pick = (row, names) => {
  for (const n of names) {
    if (row[n] != null && String(row[n]).trim() !== '') return row[n];
  }
  return null;
};

/**
 * Dates arrive as "03-01-2026 18:49:47", "03-01-2026" or ISO, under a handful
 * of different names. Returns { date: 'YYYY-MM-DD', at: original } so a
 * front-end can sort on one and display the other.
 */
function whenOf(row) {
  const raw = blank(pick(row, [
    'challan_date_time', 'challanDateTime', 'challan_date', 'challanDate',
    'date_time', 'offence_date', 'violation_date',
  ]));
  if (!raw) return { date: null, at: null };
  let m = /^(\d{1,2})-(\d{1,2})-(\d{4})/.exec(raw);            // 03-01-2026 [time]
  if (m) return { date: `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`, at: raw };
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);                     // ISO
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, at: raw };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw);               // 03/01/2026
  if (m) return { date: `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`, at: raw };
  return { date: null, at: raw };
}

/* Fields we map explicitly; everything else is kept under `extra`. */
const KNOWN = new Set([
  'challan_no','challanNo','challan_number','challan_date','challanDate',
  'challan_date_time','challanDateTime','date_time','offence_date','violation_date',
  'amount','fine_imposed','challan_status','status','offence_details','offence',
  'violation','offence_name','court_status','challan_place','place','state',
  'receipt_no','received_amount','sent_to_reg_court','department',
  'driver_name','owner_name','name_of_violator','accused_name',
]);

function mapChallan(row, state) {
  const when = whenOf(row);
  const extra = {};
  for (const [k, v] of Object.entries(row)) {
    if (KNOWN.has(k)) continue;
    const t = typeof v === 'object' ? v : blank(v);
    if (t != null && t !== '') extra[k] = t;
  }

  return {
    challan_no: blank(pick(row, ['challan_no','challanNo','challan_number'])),
    challan_date: when.date,               // YYYY-MM-DD, sortable
    challan_at: when.at,                   // original, with time if present
    amount_paise: paise(pick(row, ['amount','fine_imposed'])),
    paid_paise: paise(pick(row, ['received_amount'])),
    status: blank(pick(row, ['challan_status','status'])) || state,
    // Always readable text, whatever shape ULIP sent.
    offence: text(pick(row, ['offence_details','offence','violation','offence_name'])),
    place: text(pick(row, ['challan_place','place'])),
    department: text(pick(row, ['department'])),
    receipt_no: blank(pick(row, ['receipt_no'])),
    court_status: text(pick(row, ['court_status','sent_to_reg_court'])),
    // Masked by ULIP at source; kept because a buyer may want to match a name.
    violator_name: blank(pick(row, ['name_of_violator','driver_name','accused_name','owner_name'])),
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

/** Newest first — a front-end should not have to sort this itself. */
const byDateDesc = (a, b) => String(b.challan_date || '').localeCompare(String(a.challan_date || ''));

/** Returns { ok, data, calls }. Zero challans is a successful answer. */
async function fetchChallans(regNo, { includeRaw = false } = {}) {
  const r = await post('ECHALLAN/01', { vehicleNumber: regNo });
  const calls = [{ path: r.path, outcome: r.outcome, code: r.code, ms: r.durationMs }];

  if (r.outcome === OUTCOME.NOT_FOUND) {          // 305 — no record for this vehicle
    return { ok: true, data: empty(), noRecords: true, calls };
  }
  if (r.outcome !== OUTCOME.FOUND) {
    return { ok: false, data: null, code: r.code, error: r.message || 'Challan lookup failed', calls };
  }

  const payload = r.payload || {};
  if (String(payload.code ?? '') === '305') {
    return { ok: true, data: empty(), noRecords: true, calls };
  }

  const inner = payload.data || {};
  const pending = (Array.isArray(inner.Pending_data) ? inner.Pending_data : [])
    .map(x => mapChallan(x, 'pending')).sort(byDateDesc);
  const disposed = (Array.isArray(inner.Disposed_data) ? inner.Disposed_data : [])
    .map(x => mapChallan(x, 'disposed')).sort(byDateDesc);
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
      ...(includeRaw ? { _raw: inner } : {}),
    },
    calls,
  };
}

module.exports = { fetchChallans, mapChallan, text, whenOf };
