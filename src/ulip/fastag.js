/**
 * src/ulip/fastag.js
 * ---------------------------------------------------------------------------
 * FASTag lookup.
 *
 *   FASTAG/02 — tag list for a vehicle. Primary: it answered correctly for a
 *               real vehicle where /01 returned FAILURE.
 *   FASTAG/01 — toll transactions. Useful, but unreliable as a tag source.
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

const noTag = () => ({
  tags: [], active_tag: null, tag_count: 0, has_active_tag: false,
  checked_at: new Date().toISOString(),
});

/** Returns { ok, data, calls }. A vehicle with no tag is a valid answer. */
async function fetchFastag(regNo, _opts = {}) {
  const r = await post('FASTAG/02', { vehiclenumber: regNo, tagid: '' });
  const calls = [{ path: r.path, outcome: r.outcome, code: r.code, ms: r.durationMs }];

  if (r.outcome === OUTCOME.NOT_FOUND) return { ok: true, data: noTag(), calls };   // 740
  if (r.outcome !== OUTCOME.FOUND) {
    return { ok: false, data: null, code: r.code, error: r.message || 'FASTag lookup failed', calls };
  }

  const p = r.payload || {};

  // Dataset-level failure nested inside a successful envelope.
  if (/^FAIL/i.test(String(p.result || ''))) {
    const err = String(p?.vehicle?.errCode ?? p.respCode ?? '');
    if (err === '740') return { ok: true, data: noTag(), calls };
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
      checked_at: new Date().toISOString(),
    },
    calls,
  };
}

module.exports = { fetchFastag, mapTag, fold };
