/**
 * src/util/plate.js
 * ---------------------------------------------------------------------------
 * Registration-number normalisation and validation.
 *
 * Small file, disproportionate value. ULIP enforces ^[A-Z0-9]{5,11}$ and
 * answers anything else with a 400, but people do not type like that. On
 * WhatsApp the same vehicle arrives as:
 *
 *     ka 02 ex 1480      KA02-EX-1480      KA02 EX1480
 *     ka02ex1480         KA.02.EX.1480     KA/02/EX/1480
 *     IND KA02EX1480     "my car KA02EX1480"
 *     KAO2EX148O         (letter O typed for zero — extremely common)
 *
 * All of those are one vehicle. Rejecting them, or worse spending a lookup on
 * them, is the difference between a product that works on a ₹6,000 phone and
 * one that only works for people who type carefully.
 *
 * Validation is structural, not just character-based: a real Indian
 * registration has a shape, and checking it catches typos BEFORE the call
 * instead of after a "vehicle not found" that was never the RTO's fault.
 * ---------------------------------------------------------------------------
 */

// Copied from ULIP's own 400 message so the two can never drift apart.
const ULIP_PATTERN = /^[A-Z0-9]{5,11}$/;
// FASTag also accepts a tag id, which is longer.
const TAG_PATTERN = /^[A-Z0-9]{17,20}$/;

/**
 * Every state and union-territory code actually issued. Checking this catches
 * the whole class of typos where the shape is right but the state is not —
 * "KI02EX1480" looks perfectly valid to a regex.
 */
const STATE_CODES = new Set([
  'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'DD', 'DL', 'DN', 'GA', 'GJ', 'HP',
  'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP', 'MZ', 'NL',
  'OD', 'OR', 'PB', 'PY', 'RJ', 'SK', 'TN', 'TR', 'TS', 'UK', 'UA', 'UP', 'WB',
]);

/**
 * The shapes a registration actually takes.
 *
 * standard  KA02EX1480, KA31N8147, DL8CAF5031, MH12VT7537
 *           state(2) + district(1-2) + series(0-3 letters) + number(1-4)
 * bh        22BH1234AB — the newer series, no state code at all
 * defence   Army and paramilitary, e.g. 08A123456 / 21BX456789A
 */
const FORMATS = [
  { name: 'standard', re: /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/ },
  { name: 'bh',       re: /^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/ },
  { name: 'defence',  re: /^(\d{2})([A-Z]{1,2})(\d{6})([A-Z]?)$/ },
];

/** Words people put around a plate. Removed before anything else. */
const NOISE = /\b(IND|INDIA|VEHICLE|VAHAN|NUMBER|NUMBR|NO|NUM|REG|REGN|GAADI|CAR|BIKE|MY|IS|CHECK)\b/gi;

/**
 * "ka-31 n 8147" -> "KA31N8147". Never throws.
 * Strips every separator people use: spaces, hyphens, dots, slashes, and the
 * invisible characters that arrive when text is pasted from another app.
 */
const normalize = (input) =>
  String(input ?? '')
    .replace(/[​-‍﻿]/g, '')   // zero-width junk from copy-paste
    .toUpperCase()
    .replace(NOISE, '')
    .replace(/[^A-Z0-9]/g, '');

const isValid = (regNo) => ULIP_PATTERN.test(regNo);
const isTagId = (v) => TAG_PATTERN.test(v);

/** Which format does this match, if any? */
function shapeOf(regNo) {
  for (const f of FORMATS) {
    const m = f.re.exec(regNo);
    if (!m) continue;
    if (f.name === 'standard' && !STATE_CODES.has(m[1])) continue;
    return { format: f.name, parts: m.slice(1) };
  }
  return null;
}

/**
 * Fix the confusions that come from reading a plate rather than knowing it:
 * letter O for zero, I for one, S for five, and the reverse.
 *
 * WHY EVERY READING IS TRIED RATHER THAN A POSITIONAL GUESS: "KAO2EX148O" can
 * be split as KA-02-EXI-480 or KA-02-EX-1480, and both are structurally legal.
 * Guessing the field boundaries first picks the wrong vehicle. So each
 * ambiguous character is allowed to be either form, every combination is
 * tested, and the winner is chosen by what real registrations look like — a
 * four-digit tail beats a three-digit one, and fewer changes beat more.
 *
 * Only applied when the input is not already a valid registration, so a
 * correct plate is never "corrected" into a different one.
 */
const AMBIGUOUS = {
  O: '0', Q: '0', I: '1', L: '1', Z: '2', S: '5', B: '8',
  0: 'O', 1: 'I', 2: 'Z', 5: 'S', 8: 'B',
};
const MAX_AMBIGUOUS = 8;      // 2^8 = 256 candidates, still instant

function repair(regNo) {
  if (shapeOf(regNo)) return regNo;

  const positions = [];
  for (let i = 0; i < regNo.length; i++) {
    if (AMBIGUOUS[regNo[i]] !== undefined) positions.push(i);
  }
  if (!positions.length || positions.length > MAX_AMBIGUOUS) return regNo;

  const chars = regNo.split('');
  let best = null;

  for (let mask = 0; mask < (1 << positions.length); mask++) {
    const candidate = chars.slice();
    let changes = 0;
    for (let b = 0; b < positions.length; b++) {
      if (mask & (1 << b)) {
        candidate[positions[b]] = AMBIGUOUS[chars[positions[b]]];
        changes++;
      }
    }
    const text = candidate.join('');
    const shape = shapeOf(text);
    if (!shape) continue;

    // A registration's last group is its serial number, and four digits is by
    // far the most common. Prefer that, then prefer changing less.
    const tail = shape.parts[shape.parts.length - 1].length;
    const score = tail * 100 - changes;
    if (!best || score > best.score) best = { text, score };
  }

  return best ? best.text : regNo;
}

/**
 * Normalise, repair and validate together.
 * Returns { ok, regNo, pretty, format, repaired, error }.
 * `error` is written to be shown to a person as-is.
 */
function parse(input) {
  const raw = normalize(input);

  if (!raw) {
    return { ok: false, regNo: '', error: 'Please send the vehicle number, for example *KA02EX1480*.' };
  }

  const regNo = repair(raw);
  const repaired = regNo !== raw;

  if (regNo.length < 5) {
    return { ok: false, regNo, repaired,
      error: `*${regNo}* looks too short for a vehicle number. Please check and send it again.` };
  }
  if (regNo.length > 11) {
    return { ok: false, regNo, repaired,
      error: `*${regNo}* looks too long for a vehicle number. Please send only the number, for example *KA02EX1480*.` };
  }
  if (!isValid(regNo)) {
    return { ok: false, regNo, repaired,
      error: 'A vehicle number can only contain letters and digits. Please send it again.' };
  }

  const shape = shapeOf(regNo);
  if (!shape) {
    // Length and characters are fine, so say something more useful than
    // "invalid" — the state code is the usual culprit.
    const looksStateLike = /^[A-Z]{2}/.test(regNo);
    return { ok: false, regNo, repaired,
      error: looksStateLike && !STATE_CODES.has(regNo.slice(0, 2))
        ? `I do not recognise *${regNo.slice(0, 2)}* as a State code. Please check the number and send it again.`
        : `*${regNo}* does not look like a vehicle number. Please send it like *KA02EX1480*.` };
  }

  return { ok: true, regNo, pretty: pretty(regNo), format: shape.format, repaired, error: null };
}

/** KA02EX1480 -> "KA 02 EX 1480" for display. Best effort. */
function pretty(regNo) {
  const n = normalize(regNo);
  const shape = shapeOf(n);
  if (!shape) return n;
  return shape.parts.filter(Boolean).join(' ');
}

/**
 * Pull every registration out of a free-text message, in order and without
 * duplicates. A partner enrolling a family sends four plates in one message;
 * an owner sends one with "check this" around it.
 */
function extractAll(text) {
  const found = [];
  const seen = new Set();
  // Candidate runs of plate-ish characters, allowing the separators people use.
  for (const chunk of String(text ?? '').split(/[\n,;]+|\s{2,}/)) {
    const p = parse(chunk);
    if (p.ok && !seen.has(p.regNo)) { seen.add(p.regNo); found.push(p.regNo); }
  }
  if (found.length) return found;

  // Nothing line-by-line: try the message as one plate ("check ka02ex1480").
  const single = parse(text);
  return single.ok ? [single.regNo] : [];
}

module.exports = {
  normalize, isValid, isTagId, parse, pretty, extractAll,
  shapeOf, STATE_CODES, ULIP_PATTERN,
};
