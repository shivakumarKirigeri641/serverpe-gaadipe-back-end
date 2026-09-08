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
function mapJson(regNo, d) {
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

async function tryV4(regNo) {
  const r = await post('VAHAN/04', { vehiclenumber: regNo });
  if (r.outcome === OUTCOME.FOUND && r.payload && typeof r.payload === 'object') {
    return { ...r, data: mapJson(regNo, r.payload), source: 'VAHAN/04' };
  }
  return { ...r, data: null, source: 'VAHAN/04' };
}

async function tryV1(regNo) {
  const r = await post('VAHAN/01', { vehiclenumber: regNo });
  if (r.outcome === OUTCOME.FOUND && typeof r.payload === 'string' && r.payload.includes('<')) {
    // A genuine miss can also arrive as XML with no registration number.
    const data = mapXml(regNo, r.payload);
    if (data.reg_no) return { ...r, data, source: 'VAHAN/01' };
    return { ...r, outcome: OUTCOME.NOT_FOUND, code: '231', message: 'Vehicle Details not Found', data: null, source: 'VAHAN/01' };
  }
  return { ...r, data: null, source: 'VAHAN/01' };
}

/**
 * Fetch RC, with the fallback rule described at the top of this file.
 * `calls` lists every physical request made, so cost stays measurable.
 */
async function fetchRc(regNo) {
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

  // A login failure is not worth a fallback: both datasets sit behind the same
  // token, so the second call would fail identically and burn another attempt.
  if (String(first.message || '').includes('ULIP login failed')) {
    return { ok: false, notFound: false, data: null, source: null, code: 'AUTH',
             error: 'Cannot authenticate with ULIP. Check credentials and that this host is whitelisted.', calls };
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

  return { ok: false, notFound: false, data: null, source: null,
           code: second.code || first.code,
           error: 'VAHAN is not responding. Please try again in a few minutes.', calls };
}

module.exports = { fetchRc, mapJson, mapXml, parseDate };
