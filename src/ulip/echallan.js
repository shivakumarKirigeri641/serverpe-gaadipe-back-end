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

/**
 * Offences come as an array of objects:
 *   [{ act: "179 (1)", name: "Disobedience of orders…", offence_id: 9416 }]
 *
 * Returned structured so a front-end can render "§179(1) — Disobedience…" or
 * group by id, and one challan carrying three violations stays three items
 * rather than one mashed-together string.
 */
function offencesOf(v) {
  const list = Array.isArray(v) ? v : (v == null ? [] : [v]);
  return list.map((o) => {
    if (o == null) return null;
    if (typeof o !== 'object') return { act: null, name: blank(o), id: null };
    return {
      act: blank(o.act ?? o.section ?? o.mv_act),
      name: blank(o.name ?? o.description ?? o.offence ?? o.violation),
      id: o.offence_id ?? o.id ?? null,
    };
  }).filter((o) => o && (o.name || o.act));
}

/** Tolerant yes/no: values arrive padded and inconsistently cased. */
const yes = (v) => /^y/i.test(String(v ?? '').trim());

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
  'receipt_no','received_amount','sent_to_reg_court','sent_to_virtual_court',
  'department','state_code','act','offence_id','rto_distric_name','rto_district_name',
  'remark','document_impounded','dl_no','court_name','court_address',
  'date_of_proceeding','sent_to_court_on','amount_of_fine_imposed',
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
    // Structured, plus a ready-to-display string. Whatever shape ULIP sent.
    offences: offencesOf(pick(row, ['offence_details','offence','violation','offence_name'])),
    offence: text(pick(row, ['offence_details','offence','violation','offence_name'])),
    place: text(pick(row, ['challan_place','place'])),
    department: text(pick(row, ['department'])),
    receipt_no: blank(pick(row, ['receipt_no'])),
    court_status: text(pick(row, ['court_status'])),
    // Two separate court flags in the payload, not one.
    // Values arrive padded — a real row carried " No" with a leading space, so
    // an untrimmed /^y/ test would silently mark a court case as false.
    sent_to_court: yes(pick(row, ['sent_to_reg_court'])),
    sent_to_virtual_court: yes(pick(row, ['sent_to_virtual_court'])),
    sent_to_court_on: blank(pick(row, ['sent_to_court_on'])),
    court_name: blank(pick(row, ['court_name'])),
    court_address: blank(pick(row, ['court_address'])),
    proceeding_date: blank(pick(row, ['date_of_proceeding'])),
    // Challans follow the vehicle across states, so the issuing state is not
    // necessarily the vehicle's own RTO state.
    state_code: blank(pick(row, ['state_code'])),
    rto_district: blank(pick(row, ['rto_distric_name','rto_district_name'])),
    remark: blank(pick(row, ['remark'])),
    document_impounded: blank(pick(row, ['document_impounded'])),
    dl_no: blank(pick(row, ['dl_no'])),
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

/**
 * A fleet vehicle came back with 352 pending challans worth ₹12.9 lakh in a
 * 683 KB response. Nobody can read that, and no WhatsApp message or PDF can
 * carry it — so every response also carries the shape a human actually needs:
 * totals, the date range, and which offences dominate.
 */
function summarise(pending, disposed) {
  const dates = [...pending, ...disposed].map(c => c.challan_date).filter(Boolean).sort();
  const byOffence = new Map();
  for (const c of pending) {
    for (const o of (c.offences.length ? c.offences : [{ name: c.offence || 'Unspecified', act: null }])) {
      const key = o.name || o.act || 'Unspecified';
      const cur = byOffence.get(key) || { offence: key, act: o.act || null, count: 0, amount_paise: 0 };
      cur.count += 1;
      cur.amount_paise += c.amount_paise || 0;
      byOffence.set(key, cur);
    }
  }
  const byState = new Map();
  for (const c of pending) {
    const k = c.state_code || 'unknown';
    byState.set(k, (byState.get(k) || 0) + 1);
  }
  return {
    total_pending: pending.length,
    total_pending_amount_paise: pending.reduce((t, c) => t + (c.amount_paise || 0), 0),
    total_disposed: disposed.length,
    oldest_challan_date: dates[0] || null,
    newest_challan_date: dates[dates.length - 1] || null,
    in_court: pending.filter(c => c.sent_to_court || c.sent_to_virtual_court).length,
    top_offences: [...byOffence.values()].sort((a, b) => b.amount_paise - a.amount_paise).slice(0, 5),
    states: [...byState.entries()].map(([state_code, count]) => ({ state_code, count }))
      .sort((a, b) => b.count - a.count),
  };
}

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
      summary: summarise(pending, disposed),
      checked_at: new Date().toISOString(),
      ...(includeRaw ? { _raw: inner } : {}),
    },
    calls,
  };
}

module.exports = { fetchChallans, mapChallan, text, whenOf, summarise, offencesOf };
