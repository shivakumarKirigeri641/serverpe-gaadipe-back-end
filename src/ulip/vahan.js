/**
 * src/ulip/vahan.js
 * ---------------------------------------------------------------------------
 * Registration certificate (RC).
 *
 * ULIP exposes the same vehicle through six datasets — 01/02/03 return XML
 * keyed on vehicle number, chassis and engine; 04/05/06 return the same in
 * JSON. We use the two keyed on the vehicle number:
 *
 *   VAHAN/04 — JSON, richer. Primary.
 *   VAHAN/01 — flat XML.     Fallback.
 *
 * THE FALLBACK RULE, which is the point of this file:
 *
 *   /04 returns data                    -> done
 *   /04 says code 231 (not found)       -> STOP. Do not call /01.
 *   /04 fails any other way             -> try /01
 *
 * The previous implementation could not tell those apart — it collapsed
 * "mapping error" and "no such vehicle" into the same null and always fell
 * back — so every mistyped plate cost two API calls instead of one. Free while
 * ULIP is free; a permanent tax on the free-check funnel once it is not.
 *
 * ON PII: ULIP masks at source. Owner name arrives as "S********R V K******I",
 * chassis and engine partly starred, address as district + pincode, mobile
 * null. We keep those values as received — they are still enough to check a
 * name against a seller's ID without revealing it.
 * ---------------------------------------------------------------------------
 */

const { post, OUTCOME } = require('./client');
const { config } = require('../config');

const blank = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};
const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const int = (v) => {
  const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

const MONTHS = { JAN:1, FEB:2, MAR:3, APR:4, MAY:5, JUN:6, JUL:7, AUG:8, SEP:9, OCT:10, NOV:11, DEC:12 };

/**
 * VAHAN mixes date formats within one vehicle: "13-Sep-2021" in most fields but
 * "12-09-2036" in the XML tax field. Both are handled; anything unrecognised
 * returns null rather than an Invalid Date that would silently poison every
 * comparison downstream.
 */
function parseDate(v) {
  const s = blank(v);
  if (!s) return null;
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m) {
    const mm = MONTHS[m[2].toUpperCase()];
    return mm ? `${m[3]}-${String(mm).padStart(2,'0')}-${m[1].padStart(2,'0')}` : null;
  }
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/** The shape the rest of the system works with — provider-agnostic. */
/*
 * WHAT THE NUMBER ITSELF SAYS (2026-10-07: an IDSPay answer came without its RTO
 * code). The state and RTO are read from the registration number when a source
 * leaves them out, so every source — ULIP, eChallan.app, IDSPay — gives the same
 * fields. A source's own value always wins.
 */
function fillFromReg(data, regNo) {
  if (!data) return data;
  const reg = String(data.reg_no || regNo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!data.rto_code) {
    const code = require('../admin/geo').rtoCode(reg);
    if (code && !code.startsWith('BH')) data.rto_code = code;
  }
  if (!data.state_code && /^[A-Z]{2}/.test(reg) && !reg.startsWith('BH') && !/^\d{2}BH/.test(reg)) data.state_code = reg.slice(0, 2);
  return data;
}

/*
 * A FOUND answer that left out fields every vehicle has (2026-10-07): names
 * only, never values — enough to spot a source whose field names changed.
 */
const ALWAYS = ['maker', 'model', 'vehicle_class', 'fuel', 'reg_date', 'owner_serial', 'registered_at'];
function noteGaps(source, regNo, data) {
  const gaps = ALWAYS.filter((k) => data?.[k] == null || data[k] === '');
  if (gaps.length) console.warn('[rc-map] %s answer for %s…: empty %s', source, String(regNo || '').slice(0, 4), gaps.join(', '));
}

function mapJson(regNo, d) {
  return fillFromReg(mapJsonRaw(regNo, d), regNo);
}

function mapJsonRaw(regNo, d) {
  return {
    reg_no: blank(d.rcRegnNo) || regNo,
    status: blank(d.rcStatus),
    status_as_on: parseDate(d.rcStatusAsOn),
    state_code: blank(d.stateCd),
    rto_code: blank(d.rtoCd),
    registered_at: blank(d.rcRegisteredAt),

    reg_date: parseDate(d.rcRegnDt),
    reg_upto: parseDate(d.rcRegnUpto),
    purchase_date: parseDate(d.rcPurchaseDt),
    manufactured: blank(d.rcManuMonthYr),

    maker: blank(d.rcMakerDesc),
    model: blank(d.rcMakerModel),
    vehicle_class: blank(d.rcVhClassDesc),
    vehicle_category: blank(d.rcVchCatgDesc),
    body_type: blank(d.rcBodyTypeDesc),
    fuel: blank(d.rcFuelDesc),
    colour: blank(d.rcColor),
    norms: blank(d.rcNormsDesc),
    cubic_capacity: num(d.rcCubicCap),
    cylinders: int(d.rcNoCyl),
    seats: int(d.rcSeatCap),
    wheelbase: int(d.rcWheelbase),
    unladen_weight: int(d.rcUnldWt),
    gross_weight: int(d.rcGvw),
    sale_amount: num(d.rcSaleAmt),

    // Masked by ULIP before it reaches us.
    owner_name: blank(d.rcOwnerName),
    owner_serial: int(d.rcOwnerSr),
    owner_type: blank(d.rcOwnerCdDesc),
    owner_category: blank(d.rcOwnCatgDesc),
    address: blank(d.rcPresentAddress),
    chassis: blank(d.rcChasiNo),
    engine: blank(d.rcEngNo),

    // The four a used-car buyer is actually paying to see.
    financer: blank(d.rcFinancer),
    blacklist_status: blank(d.rcBlacklistStatus),
    noc_details: blank(d.rcNocDetails),
    noc_date: parseDate(d.rcNocDt),

    insurance_company: blank(d.rcInsuranceComp),
    insurance_policy: blank(d.rcInsurancePolicyNo),
    insurance_upto: parseDate(d.rcInsuranceUpto),

    pucc_number: blank(d.rcPuccNo),
    pucc_upto: parseDate(d.rcPuccUpto),
    fitness_upto: parseDate(d.rcFitUpto),
    tax_upto: parseDate(d.rcTaxUpto),

    permit_number: blank(d.rcPermitNo),
    permit_upto: parseDate(d.rcPermitValidUpto),
    permit_type: blank(d.rcPermitType),
  };
}

/** Minimal reader for the flat VAHAN/01 document — no XML dependency needed. */
const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].trim() : null;
};

function mapXml(regNo, xml) {
  const g = (t) => tag(xml, t);
  return mapJson(regNo, {
    rcRegnNo: g('rc_regn_no'), rcStatus: g('rc_status'), rcStatusAsOn: g('rc_status_as_on'),
    stateCd: g('state_cd'), rtoCd: g('rto_cd'), rcRegisteredAt: g('rc_registered_at'),
    rcRegnDt: g('rc_regn_dt'), rcRegnUpto: g('rc_regn_upto'), rcPurchaseDt: g('rc_purchase_dt'),
    rcManuMonthYr: g('rc_manu_month_yr'),
    rcMakerDesc: g('rc_maker_desc'), rcMakerModel: g('rc_maker_model'),
    rcVhClassDesc: g('rc_vhclass_desc') || g('rc_vh_class_desc'),
    rcVchCatgDesc: g('rc_vch_catg_desc'), rcBodyTypeDesc: g('rc_body_type_desc'),
    rcFuelDesc: g('rc_fuel_desc'), rcColor: g('rc_color'), rcNormsDesc: g('rc_norms_desc'),
    rcCubicCap: g('rc_cubic_cap'), rcNoCyl: g('rc_no_cyl'), rcSeatCap: g('rc_seat_cap'),
    rcWheelbase: g('rc_wheelbase'), rcUnldWt: g('rc_unld_wt'), rcGvw: g('rc_gvw'),
    rcSaleAmt: g('rc_sale_amt'),
    rcOwnerName: g('rc_owner_name'), rcOwnerSr: g('rc_owner_sr'),
    rcOwnerCdDesc: g('rc_owner_cd_desc'), rcOwnCatgDesc: g('rc_own_catg_desc'),
    rcPresentAddress: g('rc_present_address'),
    rcChasiNo: g('rc_chasi_no'), rcEngNo: g('rc_eng_no'),
    rcFinancer: g('rc_financer'), rcBlacklistStatus: g('rc_blacklist_status'),
    rcNocDetails: g('rc_noc_details'), rcNocDt: g('rc_noc_dt'),
    rcInsuranceComp: g('rc_insurance_comp'), rcInsurancePolicyNo: g('rc_insurance_policy_no'),
    rcInsuranceUpto: g('rc_insurance_upto'),
    rcPuccNo: g('rc_pucc_no'), rcPuccUpto: g('rc_pucc_upto'),
    rcFitUpto: g('rc_fit_upto'), rcTaxUpto: g('rc_tax_upto'),
  });
}

/*
 * READ WHATEVER ARRIVES (user, 2026-10-01). A "found" answer whose body we
 * could not read was passed on as a success with an empty record — so new
 * numbers showed no make, model or type while cached ones looked fine. Now the
 * body is read in any form ULIP sends — XML, JSON text or an object, keys as
 * rc_maker_desc or rcMakerDesc, flat or one level down — and a record with
 * nothing in it is a FAILURE: never cached, never shown, the other dataset
 * tried. Its shape (field names only) is logged so a format change is visible.
 */
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
function readAny(payload) {
  let p = payload;
  if (typeof p === 'string') {
    const s = p.trim();
    if (s.startsWith('<')) return { xml: s };
    if (s.startsWith('{') || s.startsWith('[')) { try { p = JSON.parse(s); } catch { return null; } } else return null;
  }
  if (Array.isArray(p)) p = p[0];
  if (!p || typeof p !== 'object') return null;
  const flat = {};
  for (const [k, v] of Object.entries(p)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) if (v2 == null || typeof v2 !== 'object') flat[norm(k2)] ??= v2;
    } else flat[norm(k)] = v;
  }
  return { obj: new Proxy(flat, { get: (t, prop) => (typeof prop === 'string' ? t[norm(prop)] : undefined) }), keys: Object.keys(flat) };
}
const usable = (d) => Boolean(d && (d.maker || d.model || d.vehicle_class || d.reg_date));
const shapeOf = (payload) => {
  if (payload == null) return 'empty';
  if (typeof payload === 'string') return `text(${payload.length}) "${payload.slice(0, 20).replace(/[A-Za-z0-9]/g, 'x')}…"`;
  return `${Array.isArray(payload) ? 'array' : 'object'} keys=[${Object.keys(Array.isArray(payload) ? payload[0] || {} : payload).slice(0, 25).join(',')}]`;
};

function mapAny(regNo, payload) {
  const r = readAny(payload);
  if (!r) return null;
  return r.xml ? mapXml(regNo, r.xml) : mapJson(regNo, r.obj);
}

async function tryV4(regNo) {
  const r = await post('VAHAN/04', { vehiclenumber: regNo });
  if (r.outcome === OUTCOME.FOUND) {
    const data = mapAny(regNo, r.payload);
    if (usable(data)) { noteGaps('VAHAN/04', regNo, data); return { ...r, data, source: 'VAHAN/04' }; }
    console.warn(`[vahan] VAHAN/04 ${regNo}: "found" but unreadable or empty — ${shapeOf(r.payload)}`);
    return { ...r, outcome: OUTCOME.RETRY, code: 'EMPTY_RECORD', message: 'VAHAN/04 returned no usable record', data: null, source: 'VAHAN/04' };
  }
  return { ...r, data: null, source: 'VAHAN/04' };
}

async function tryV1(regNo) {
  const r = await post('VAHAN/01', { vehiclenumber: regNo });
  if (r.outcome === OUTCOME.FOUND) {
    const data = mapAny(regNo, r.payload);
    if (usable(data)) { noteGaps('VAHAN/01', regNo, data); return { ...r, data, source: 'VAHAN/01' }; }
    console.warn(`[vahan] VAHAN/01 ${regNo}: "found" but unreadable or empty — ${shapeOf(r.payload)}`);
    return { ...r, outcome: OUTCOME.RETRY, code: 'EMPTY_RECORD', message: 'VAHAN/01 returned no usable record', data: null, source: 'VAHAN/01' };
  }
  return { ...r, data: null, source: 'VAHAN/01' };
}

/**
 * Fetch RC, with the fallback rule described at the top of this file.
 * `calls` lists every physical request made, so cost stays measurable.
 */
async function fetchRc(regNo, opts = {}) {
  const calls = [];
  const primaryIsXml = config.ulip.vahanPrimary === '01';

  const first = primaryIsXml ? await tryV1(regNo) : await tryV4(regNo);
  calls.push({ path: first.path, outcome: first.outcome, code: first.code, ms: first.durationMs });

  if (first.outcome === OUTCOME.FOUND) {
    return { ok: true, data: first.data, source: first.source, calls };
  }

  // The vehicle genuinely is not in VAHAN. No other dataset will find it, so
  // stop here rather than paying for a second lookup to be told the same thing.
  if (first.outcome === OUTCOME.NOT_FOUND) {
    return { ok: false, notFound: true, data: null, source: first.source,
             code: first.code, error: first.message || 'Vehicle not found in VAHAN', calls };
  }

  /* ULIP'S OWN DAILY LIMIT (2026-10-07): "Daily API limit exceeded for your
     account". ULIP is still asked on every check (the user removed GaadiPe's own
     pause), but its other format shares the same exhausted quota, so it is not
     asked a second time: eChallan.app, then IDSPay, straight away. */
  if (/daily api limit|limit exceeded/i.test(String(first.message || ''))) {
    return backup(regNo, calls, opts, { ok: false, notFound: false, data: null, source: null, code: 'ULIP_DAILY_LIMIT',
             error: 'VAHAN is not responding. Please try again in a few minutes.', calls });
  }

  // A login failure is not worth a fallback: both datasets sit behind the same
  // token, so the second call would fail identically and burn another attempt.
  if (String(first.message || '').includes('ULIP login failed')) {
    return backup(regNo, calls, opts, { ok: false, notFound: false, data: null, source: null, code: 'AUTH',
             error: 'Cannot authenticate with ULIP. Check credentials and that this host is whitelisted.', calls });
  }

  // Anything else — mapping error, timeout, 5xx — is worth a second try on the
  // other format, which fails independently.
  const second = primaryIsXml ? await tryV4(regNo) : await tryV1(regNo);
  calls.push({ path: second.path, outcome: second.outcome, code: second.code, ms: second.durationMs });

  if (second.outcome === OUTCOME.FOUND) {
    console.warn(`[vahan] ${regNo} served by ${second.source} after ${first.source} failed (${first.code})`);
    return { ok: true, data: second.data, source: second.source, fallback: true, calls };
  }
  if (second.outcome === OUTCOME.NOT_FOUND) {
    return { ok: false, notFound: true, data: null, source: second.source,
             code: second.code, error: second.message || 'Vehicle not found in VAHAN', calls };
  }

  return backup(regNo, calls, opts, { ok: false, notFound: false, data: null, source: null,
           code: second.code || first.code,
           error: 'VAHAN is not responding. Please try again in a few minutes.', calls });
}

/*
 * ULIP FAILED, SO THE PAID BACKUP (user, 2026-10-02; vehicle/rcBackup.js).
 * Only ever reached after ULIP failed — never after its "not found". When the
 * backup is off, over its daily limit, or fails too, ULIP's failure stands.
 */
async function backup(regNo, calls, opts, failure) {
  /*
   * THE ORDER (user, 2026-10-05): ULIP (free) -> eChallan.app (free) -> IDSPay (₹3).
   *   ulipOnly   ULIP and nothing else — the VAHAN watchdog and the admin's
   *              Check vehicle ask "is ULIP itself answering?"
   *   noBackup   no PAID backup — the free eChallan.app is still tried
   */
  if (opts.ulipOnly) return failure;
  const free = await require('../vehicle/echallanApp').rc(regNo).catch((e) => {
    console.error('[vahan] eChallan.app threw:', e.message);
    return null;
  });
  if (free) {
    calls.push({ path: 'ECHALLANAPP', outcome: free.outcome, code: free.code, ms: free.ms });
    if (free.outcome === 'FOUND') {
      console.warn(`[vahan] ${regNo} served by eChallan.app after ULIP failed (${failure.code})`);
      return { ok: true, data: free.data, source: 'ECHALLANAPP', fallback: true, ulipFailed: true, calls };
    }
    // Their "not found" is not final: IDSPay reads a different source.
  }
  if (opts.noBackup) return { ...failure, calls };
  const b = await require('../vehicle/rcBackup').lookup(regNo).catch((e) => {
    console.error('[vahan] backup threw:', e.message);
    return null;
  });
  if (!b) return failure;
  calls.push({ path: 'RCBACKUP', outcome: b.outcome, code: b.code, ms: b.ms });
  if (b.outcome === 'FOUND') {
    console.warn(`[vahan] ${regNo} served by the RC backup after ULIP failed (${failure.code})`);
    return { ok: true, data: b.data, source: 'RCBACKUP', fallback: true, ulipFailed: true, calls };
  }
  if (b.outcome === 'NOT_FOUND') {
    return { ok: false, notFound: true, data: null, source: 'RCBACKUP', code: b.code, error: 'Vehicle not found', calls };
  }
  return { ...failure, calls };
}

module.exports = { fetchRc, mapJson, mapXml, mapAny, usable, parseDate, fillFromReg, noteGaps };
