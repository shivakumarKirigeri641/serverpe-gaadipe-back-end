/**
 * src/util/plate.js
 * ---------------------------------------------------------------------------
 * Registration-number normalisation and validation.
 *
 * Small file, disproportionate value: ULIP enforces ^[A-Z0-9]{5,11}$ and
 * answers anything else with a 400. People type "KA-31-N-8147", "ka 31 n 8147"
 * and "KA31N8147" for the same vehicle. Cleaning up here, and rejecting bad
 * input BEFORE the call, is the difference between a helpful message and a
 * wasted lookup that will cost money the day ULIP starts charging.
 * ---------------------------------------------------------------------------
 */

// Copied from ULIP's own 400 message so the two can never drift apart.
const ULIP_PATTERN = /^[A-Z0-9]{5,11}$/;
// FASTag also accepts a tag id, which is longer.
const TAG_PATTERN = /^[A-Z0-9]{17,20}$/;

/** "ka-31 n 8147" -> "KA31N8147". Never throws. */
const normalize = (input) =>
  String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();

const isValid = (regNo) => ULIP_PATTERN.test(regNo);
const isTagId = (v) => TAG_PATTERN.test(v);

/**
 * Normalise and validate together.
 * Returns { ok, regNo, error } — `error` is safe to show a user as-is.
 */
function parse(input) {
  const regNo = normalize(input);
  if (!regNo) return { ok: false, regNo: '', error: 'Please enter a vehicle number.' };
  if (regNo.length < 5) return { ok: false, regNo, error: `"${regNo}" is too short for a vehicle number.` };
  if (regNo.length > 11) return { ok: false, regNo, error: `"${regNo}" is too long for a vehicle number.` };
  if (!isValid(regNo)) return { ok: false, regNo, error: 'A vehicle number can only contain letters and digits.' };
  return { ok: true, regNo, error: null };
}

/** KA31N8147 -> "KA 31 N 8147" for display. Best effort; BH series falls through. */
function pretty(regNo) {
  const n = normalize(regNo);
  const std = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/.exec(n);
  if (std) return [std[1], std[2], std[3], std[4]].filter(Boolean).join(' ');
  const bh = /^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/.exec(n);   // 22BH1234AB
  if (bh) return `${bh[1]} ${bh[2]} ${bh[3]} ${bh[4]}`;
  return n;
}

module.exports = { normalize, isValid, isTagId, parse, pretty, ULIP_PATTERN };
