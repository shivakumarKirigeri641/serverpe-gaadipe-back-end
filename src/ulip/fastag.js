/**
 * src/ulip/fastag.js
 * ---------------------------------------------------------------------------
 * FASTag lookup.
 *
 * Two different datasets, not two attempts at the same thing:
 *
 *   FASTAG/02 — TAG DETAILS: tag id, status, issue date, issuing bank.
 *   FASTAG/01 — TOLL CROSSINGS: plaza name, geocode, timestamp, lane
 *               direction. Where the vehicle has actually been.
 *
 * /01 is the more interesting one for a fleet: it shows movement. It is also
 * where a used-car buyer can sanity-check a seller's story about mileage and
 * usage. Fetched in parallel with /02 and reported separately — one failing
 * must never hide the other.
 *
 * Three things learned from real responses that would otherwise produce wrong
 * answers:
 *
 *  1. `result: "FAILURE"` appears inside HTTP 200 with responseStatus
 *     "SUCCESS". Transport success is not data success.
 *  2. errCode 740 means the vehicle simply has no tag — an ANSWER, not a
 *     fault, and plenty of vehicles have none.
 *  3. A vehicle can hold SEVERAL tags. The live test vehicle returned three:
 *     two inactive and one active. Taking the first element — the obvious
 *     thing — reports an inactive tag issued two years earlier. The active one
 *     is whichever carries TAGSTATUS "A".
 *
 * The payload is a name/value list rather than an object, so it is folded into
 * one before mapping.
 * ---------------------------------------------------------------------------
 */

const { post, OUTCOME } = require('./client');

const blank = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

/** [{name:'TAGID',value:'…'}, …] -> { TAGID:'…', … } */
function fold(detail) {
  const out = {};
  for (const d of Array.isArray(detail) ? detail : []) {
    if (d && d.name != null) out[String(d.name).toUpperCase()] = d.value;
  }
  return out;
}

const STATUS = { A: 'active', I: 'inactive', C: 'closed', L: 'low balance', E: 'exception' };

function mapTag(f) {
  const s = blank(f.TAGSTATUS);
  return {
    tag_id: blank(f.TAGID),
    reg_no: blank(f.REGNUMBER),
    tid: blank(f.TID),
    vehicle_class: blank(f.VEHICLECLASS),
    status_code: s,
    status: s ? (STATUS[s.toUpperCase()] || s) : null,
    is_active: String(s || '').toUpperCase() === 'A',
    issue_date: blank(f.ISSUEDATE),
    bank_id: blank(f.BANKID),
    exception_code: blank(f.EXCCODE),
    commercial: String(f.COMVEHICLE || '').toUpperCase() === 'T',
  };
}

/** "2021-10-30 12:26:09.0" -> { at, date } so a UI can sort and display. */
function crossingTime(v) {
  const raw = blank(v);
  if (!raw) return { at: null, date: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  return { at: raw, date: m ? `${m[1]}-${m[2]}-${m[3]}` : null };
}

function mapCrossing(t) {
  const when = crossingTime(t?.readerReadTime);
  const geo = blank(t?.tollPlazaGeocode);
  const [lat, lon] = (geo || '').split(',').map(x => {
    const n = Number(String(x).trim());
    return Number.isFinite(n) ? n : null;
  });
  return {
    at: when.at,
    date: when.date,
    plaza: blank(t?.tollPlazaName),
    lat: lat ?? null,
    lon: lon ?? null,
    direction: blank(t?.laneDirection),
    vehicle_class: blank(t?.vehicleType),
    reg_no: blank(t?.vehicleRegNo),
    seq_no: blank(t?.seqNo),
  };
}

/**
 * FASTAG/01 — recent toll crossings. Never throws and never fails the caller:
 * a vehicle with no crossings, or a dataset hiccup, simply yields an empty
 * list with a reason, because the tag details are the more important half.
 */
async function fetchCrossings(regNo) {
  const r = await post('FASTAG/01', { vehiclenumber: regNo });
  const call = { path: r.path, outcome: r.outcome, code: r.code, ms: r.durationMs };

  if (r.outcome !== OUTCOME.FOUND) {
    return { crossings: [], crossings_error: r.outcome === OUTCOME.NOT_FOUND ? null : r.message, call };
  }
  const p = r.payload || {};
  if (/^FAIL/i.test(String(p.result || ''))) {
    const err = String(p?.vehicle?.errCode ?? p.respCode ?? '');
    // 740 = no tag, so no crossings either. A normal answer.
    return { crossings: [], crossings_error: err === '740' ? null : `code ${err || 'unknown'}`, call };
  }

  const txns = p?.vehicle?.vehltxnList?.txn;
  const crossings = (Array.isArray(txns) ? txns : (txns ? [txns] : []))
    .map(mapCrossing)
    .filter(c => c.at || c.plaza)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));   // newest first
  return { crossings, crossings_error: null, call };
}

const noTag = () => ({
  tags: [], active_tag: null, tag_count: 0, has_active_tag: false,
  checked_at: new Date().toISOString(),
});

/** Returns { ok, data, calls }. A vehicle with no tag is a valid answer. */
async function fetchFastag(regNo, _opts = {}) {
  // Tags and crossings are independent datasets — fetch together, report
  // separately, so one failing never hides the other.
  const [r, trips] = await Promise.all([
    post('FASTAG/02', { vehiclenumber: regNo, tagid: '' }),
    fetchCrossings(regNo),
  ]);
  const calls = [{ path: r.path, outcome: r.outcome, code: r.code, ms: r.durationMs }, trips.call];
  const travel = {
    crossings: trips.crossings,
    crossing_count: trips.crossings.length,
    last_seen_at: trips.crossings[0]?.at || null,
    last_seen_plaza: trips.crossings[0]?.plaza || null,
    ...(trips.crossings_error ? { crossings_error: trips.crossings_error } : {}),
  };

  if (r.outcome === OUTCOME.NOT_FOUND) return { ok: true, data: { ...noTag(), ...travel }, calls };   // 740
  if (r.outcome !== OUTCOME.FOUND) {
    return { ok: false, data: null, code: r.code, error: r.message || 'FASTag lookup failed', calls };
  }

  const p = r.payload || {};

  // Dataset-level failure nested inside a successful envelope.
  if (/^FAIL/i.test(String(p.result || ''))) {
    const err = String(p?.vehicle?.errCode ?? p.respCode ?? '');
    if (err === '740') return { ok: true, data: { ...noTag(), ...travel }, calls };
    // 239 appears in ULIP's own samples with no explanation. Treated as
    // retryable: guessing "no tag" would tell a customer something false,
    // while guessing "retry" costs at most one extra call.
    return { ok: false, data: null, code: err || 'FAILURE',
             error: `FASTag lookup failed (code ${err || 'unknown'})`, calls };
  }

  const list = p?.vehicle?.vehicledetails;
  const tags = (Array.isArray(list) ? list : [])
    .map(v => mapTag(fold(v?.detail)))
    .filter(t => t.tag_id);

  // Newest active tag wins. A vehicle should have exactly one, but the data
  // does not guarantee it, so sort rather than assume.
  const active = tags.filter(t => t.is_active)
    .sort((a, b) => String(b.issue_date || '').localeCompare(String(a.issue_date || '')))[0] || null;

  return {
    ok: true,
    data: {
      tags, active_tag: active,
      tag_count: tags.length,
      has_active_tag: !!active,
      ...travel,
      checked_at: new Date().toISOString(),
    },
    calls,
  };
}

module.exports = { fetchFastag, fetchCrossings, mapTag, mapCrossing, fold };
