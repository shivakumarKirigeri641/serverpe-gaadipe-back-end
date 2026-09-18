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
 * legacy    Before the state-code scheme (1989): two or three letters and up
 *           to four digits — CRW1461, MYS123, BMR3411. Still on the road and
 *           still in VAHAN (2026-09-17). There is no state code to check, so the
 *           shape is all that is tested here and ULIP says whether it exists.
 */
const FORMATS = [
  { name: 'standard', re: /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/ },
  { name: 'bh',       re: /^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/ },
  { name: 'defence',  re: /^(\d{2})([A-Z]{1,2})(\d{6})([A-Z]?)$/ },
  /* Last, so a modern plate is always read as modern first. */
  { name: 'legacy',   re: /^([A-Z]{2,3})(\d{1,4})$/ },
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
    /* Never "correct" a mistyped modern plate into an old one: the old shape is
       loose enough that almost any short run of letters and digits fits it. */
    if (!shape || shape.format === 'legacy') continue;

    // A registration's last group is its serial number, and four digits is by
    // far the most common. Prefer that, then prefer changing less.
    const tail = shape.parts[shape.parts.length - 1].length;
    const score = tail * 100 - changes;
    if (!best || score > best.score) best = { text, score };
  }

  return best ? best.text : regNo;
}

/**
 * What makes a well-shaped number impossible, per kind — or null.
 *
 *   standard  KA01AB1234 · KA31N8147 · KA010001 — a real State/UT code, an RTO
 *             code of 01–99, up to three series letters, a serial of 1–9999.
 *   Delhi     DL3CAB1234 · DL10CA1234 — the same, but the RTO code is 1–2
 *             digits as issued, and a series is required: Delhi numbers always
 *             carry the vehicle-category letter (C, S, …) after the RTO code.
 *   bh        22BH1234AB — the Bharat series: two-digit year of registration
 *             (2021, when the scheme began, up to this year), BH, a four-digit
 *             serial that is not 0000, one or two letters (never I or O).
 *   legacy    MYS123 · BMR3411 · CRW1461 — before 1989: two or three letters
 *             and a serial of 1–9999.
 */
function strictProblem(shape) {
  const zero = (s) => /^0+$/.test(String(s || ''));
  if (shape.format === 'standard') {
    const [state, district, series, serial] = shape.parts;
    if (zero(serial)) return 'The last part of a vehicle number cannot be 0000. It should look like KA01AB1234.';
    if (state === 'DL') {
      if (zero(district)) return 'That is not a Delhi RTO code. A Delhi number looks like DL3CAB1234 or DL10CA1234.';
      if (!series) return 'A Delhi number has letters after the RTO code, like DL3CAB1234.';
      return null;
    }
    if (zero(district)) return `${state}00 is not an RTO code. It should look like ${state}01AB1234.`;
    return null;
  }
  if (shape.format === 'bh') {
    const [year, , serial, letters] = shape.parts;
    const y = Number(year);
    const thisYear = new Date().getFullYear() % 100;
    if (y < 21 || y > thisYear) {
      return `A BH-series number starts with its year of registration (21 to ${thisYear}), like 22BH1234AB.`;
    }
    if (zero(serial)) return 'The four digits of a BH-series number cannot be 0000. It should look like 22BH1234AB.';
    if (/[IO]/.test(letters)) return 'BH-series letters never include I or O. It should look like 22BH1234AB.';
    return null;
  }
  if (shape.format === 'legacy') {
    const [, serial] = shape.parts;
    if (zero(serial)) return 'The number part cannot be zero. An old-style number looks like MYS1234.';
    return null;
  }
  return null;
}

/**
 * Normalise, repair and validate together.
 * Returns { ok, regNo, pretty, format, repaired, error }.
 * `error` is written to be shown to a person as-is.
 */
function parse(input) {
  const raw = normalize(input);

  if (!raw) {
    return { ok: false, regNo: '', error: 'Please enter the vehicle number, for example KA01AB1234.' };
  }

  const regNo = repair(raw);
  const repaired = regNo !== raw;

  if (regNo.length < 5) {
    return { ok: false, regNo, repaired,
      error: `${regNo} looks too short for a vehicle number. Please check it and try again.` };
  }
  if (regNo.length > 11) {
    return { ok: false, regNo, repaired,
      error: `${regNo} looks too long for a vehicle number. Enter only the number, for example KA01AB1234.` };
  }
  if (!isValid(regNo)) {
    return { ok: false, regNo, repaired,
      error: 'A vehicle number can only contain letters and digits. Please try again.' };
  }

  const shape = shapeOf(regNo);
  if (!shape) {
    // Length and characters are fine, so say something more useful than
    // "invalid" — the state code is the usual culprit.
    const looksStateLike = /^[A-Z]{2}/.test(regNo);
    return { ok: false, regNo, repaired,
      error: looksStateLike && !STATE_CODES.has(regNo.slice(0, 2))
        ? `${regNo.slice(0, 2)} is not a State code we recognise. Please check the number and try again.`
        : `${regNo} does not look like a vehicle number. It should look like KA01AB1234.` };
  }

  /*
   * THE SERIAL IS FOUR DIGITS (2026-09-17). VAHAN records KA01A1 as KA01A0001 and
   * KA011 as KA010001; typed short, the lookup finds nothing. So a standard
   * plate's serial is padded here, once, and every caller — the booking form,
   * the gate, a check from the panel — uses the same number.
   */
  /*
   * STRICT CHECKS, per kind (user, 2026-09-18). The shape can be right while
   * the number is impossible: an RTO code of 00, a serial of 0000, a BH plate
   * from a year before the scheme existed. Each is refused here, with a sentence
   * that says what a correct one looks like, before a lookup is spent on it.
   */
  const bad = strictProblem(shape);
  if (bad) return { ok: false, regNo, repaired, error: bad };

  if (shape.format === 'standard') {
    const [state, district, series, serial] = shape.parts;
    /* THE RTO CODE IS TWO DIGITS (user, 2026-09-18): KA1AB1234 is KA01AB1234 on
       VAHAN, GJ5CD45 is GJ05CD0045. Delhi is the exception — its records keep
       the single digit (DL3CAB1234) — so it is left as typed. */
    const rto = state === 'DL' ? district : String(district).padStart(2, '0');
    const full = `${state}${rto}${series}${serial.padStart(4, '0')}`;
    return { ok: true, regNo: full, pretty: pretty(full), format: shape.format, repaired: repaired || full !== raw, error: null };
  }

  return { ok: true, regNo, pretty: pretty(regNo), format: shape.format, repaired, error: null };
}

/** For display — always without spaces (KA02EX1480), everywhere. */
function pretty(regNo) {
  return normalize(regNo);
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
