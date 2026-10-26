/**
 * src/ulip/vahan.js
 * ---------------------------------------------------------------------------
 * Registration certificate (RC).
 *
 * ULIP exposed the same vehicle through six datasets; since the ministry's notice of 2026-10-26 only VAHAN/04
 * (JSON, keyed on the vehicle number) and /05 remain, and VAHAN/04 answers GOODS VEHICLES ONLY, with limited
 * fields. We use VAHAN/04 alone:
 *
 *   /04 returns data with its dates     -> done
 *   /04 returns data without the dates  -> a paid lookup asks the full source (Way2API / IDSPay) for them
 *   /04 says not found, or fails        -> eChallan.app, then (paid lookups) Way2API / IDSPay — ULIP's
 *                                          "not found" is not final: it means "not a goods vehicle" too
 *
 * ON PII: ULIP masks at source. Owner name arrives as "S********R V K******I",
 * chassis and engine partly starred, address as district + pincode, mobile
 * null. We keep those values as received — they are still enough to check a
 * name against a seller's ID without revealing it.
 * ---------------------------------------------------------------------------
 */

const { post, OUTCOME } = require('./client');

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
/* owner_serial is not here (2026-10-08): ULIP often leaves the owner count
   out of a perfectly good answer (KA31N8147, HR26…), so naming it every time
   was noise in the log, not a sign that the field names changed. */
const ALWAYS = ['maker', 'model', 'vehicle_class', 'fuel', 'reg_date', 'registered_at'];
function noteGaps(source, regNo, data) {
  const gaps = ALWAYS.filter((k) => data?.[k] == null || data[k] === '');
  if (gaps.length) console.warn('[rc-map] %s answer for %s…: empty %s', source, String(regNo || '').slice(0, 4), gaps.join(', '));
}

function mapJson(regNo, d) {
  return fillGaps(fillFromReg(mapJsonRaw(regNo, d), regNo));
}

/*
 * WHAT A REAL ANSWER LEFT OUT (2026-10-08, KA31N8147 side by side):
 *   - rcVhType comes as a code, "N" / "T" — said in words.
 *   - rcRegnUpto was missing altogether, so the report lost its Registration
 *     row. For a NON-TRANSPORT vehicle VAHAN's fitness date IS the registration
 *     validity (15 years from registration: 13-Sep-2021 → 12-Sep-2036), so it
 *     stands in — never for a transport vehicle, whose fitness is yearly.
 */
function fillGaps(data) {
  if (!data) return data;
  const vt = String(data.vehicle_type || '').trim().toUpperCase();
  if (vt === 'N') data.vehicle_type = 'Non-transport';
  else if (vt === 'T') data.vehicle_type = 'Transport';
  const transport = /^TRANSPORT$/i.test(String(data.vehicle_type || ''))
    || /TRANSPORT|GOODS|PASSENGER|TAXI|BUS|TRUCK|LORRY|MAXI|TRAILER|CAB/i.test(`${data.vehicle_category || ''} ${data.vehicle_class || ''}`.replace(/NON[- ]?TRANSPORT/ig, ''));
  if (!data.reg_upto && data.fitness_upto && !transport) {
    data.reg_upto = data.fitness_upto;
    data.reg_upto_from = 'fitness';
  }
  return data;
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

    // Not in ULIP's VAHAN/04 or /01 (its spec has no permit fields); read when a
    // source in VAHAN's names sends them (eChallan.app may).
    permit_number: blank(d.rcPermitNo),
    permit_upto: parseDate(d.rcPermitValidUpto),
    permit_type: blank(d.rcPermitType),

    /* IN ULIP'S SPEC BUT NOT READ BEFORE (2026-10-08, the RC comparison):
       worth having for a buyer, and none of it personal. The same names come
       from eChallan.app (VAHAN's own); IDSPay has no equivalents, so they stay
       empty for its answers. */
    tax_mode: blank(d.rcTaxMode),                         // e.g. LTT (lifetime) / OTT / quarterly
    vehicle_type: blank(d.rcVhType),                      // transport / non-transport
    non_use: blank(d.rcNonUse),                           // declared off the road
    surrendered_to_dealer: blank(d.rcVehicleSurrenderedToDealer),
    goods_tax: blank(d.rcGoodsTax),
    passenger_tax: blank(d.rcPassengerTax),
    sleeper_capacity: int(d.rcSleeperCap),
    standing_capacity: int(d.rcStandCap),
    owner_history: blank(d.rcOwnerHistory),
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
    rcTaxMode: g('rc_tax_mode'), rcVhType: g('rc_vh_type'), rcNonUse: g('rc_non_use'),
    rcVehicleSurrenderedToDealer: g('rc_vehicle_surrendered_to_dealer'),
    rcGoodsTax: g('rc_goods_tax'), rcPassengerTax: g('rc_passenger_tax'),
    rcSleeperCap: g('rc_sleeper_cap'), rcStandCap: g('rc_stand_cap'),
    rcOwnerHistory: g('rc_owner_history'),
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

// VAHAN/01 (flat XML) was discontinued by the ministry (ULIP notice, 2026-10-26): no tryV1 any more, so it can
// never be called. Its XML reader (mapXml) stays for answers that still arrive as XML.

/**
 * Fetch RC, with the fallback rule described at the top of this file.
 * `calls` lists every physical request made, so cost stays measurable.
 */
/*
 * ULIP'S NOTICE OF 2026-10-26: "VAHAN/04 will provide responses for goods vehicles only", "the responses currently
 * contain limited data fields", and "VAHAN/01, /02, /03 and /06 have been discontinued".
 *   - VAHAN/01 is never called again, whatever ULIP_VAHAN_PRIMARY or ulip_vahan_second_format say.
 *   - ULIP's "not found" is no longer final: for any vehicle that is not a goods vehicle it says so about a
 *     vehicle that exists. The free source (eChallan.app) and, for a paid lookup, Way2API / IDSPay decide.
 *   - A goods vehicle's ULIP answer without its key dates (insurance, fitness, tax) is "limited": a paid lookup
 *     goes on to the full source for the dates; a free one keeps what ULIP gave.
 */
const KEY_DATES = ['insurance_upto', 'fitness_upto', 'tax_upto'];
const limited = (d) => KEY_DATES.every((k) => d?.[k] == null || d[k] === '');

async function fetchRc(regNo, opts = {}) {
  const calls = [];
  // Always VAHAN/04: VAHAN/01 is discontinued (2026-10-26), so ULIP_VAHAN_PRIMARY no longer matters.
  const first = await tryV4(regNo);
  calls.push({ path: first.path, outcome: first.outcome, code: first.code, ms: first.durationMs });

  if (first.outcome === OUTCOME.FOUND) {
    if (limited(first.data) && !opts.noBackup && !opts.ulipOnly) {
      console.warn(`[vahan] ${regNo}: VAHAN/04 answered without insurance / fitness / tax dates — asking the full source`);
      // eChallan.app is skipped here: it has make and model only, never the dates that are missing.
      const fuller = await backup(regNo, calls, { ...opts, skipFreeSource: true }, { ok: true, data: first.data, source: first.source, calls });
      // The full source answered: use it. It did not: what ULIP gave still stands.
      if (fuller?.ok && fuller.data && !limited(fuller.data)) return fuller;
      return { ok: true, data: first.data, source: first.source, calls };
    }
    return { ok: true, data: first.data, source: first.source, calls };
  }

  // ULIP's "not found" is not final any more (goods vehicles only): the other sources are asked. The VAHAN
  // watchdog (ulipOnly) still hears it as it is.
  if (first.outcome === OUTCOME.NOT_FOUND) {
    const notFound = { ok: false, notFound: true, data: null, source: first.source,
      code: first.code, error: first.message || 'Vehicle not found in the vehicle records', calls };
    if (opts.ulipOnly) return notFound;
    return backup(regNo, calls, opts, notFound);
  }

  /* ULIP'S OWN DAILY LIMIT (2026-10-07): "Daily API limit exceeded for your
     account". ULIP is still asked on every check (the user removed GaadiPe's own
     pause), but its other format shares the same exhausted quota, so it is not
     asked a second time: eChallan.app, then IDSPay, straight away. */
  if (/daily api limit|limit exceeded/i.test(String(first.message || ''))) {
    return backup(regNo, calls, opts, { ok: false, notFound: false, data: null, source: null, code: 'ULIP_DAILY_LIMIT',
             error: 'The vehicle records source is not responding. Please try again in a few minutes.', calls });
  }

  // A login failure is not worth a fallback: both datasets sit behind the same
  // token, so the second call would fail identically and burn another attempt.
  if (String(first.message || '').includes('ULIP login failed')) {
    return backup(regNo, calls, opts, { ok: false, notFound: false, data: null, source: null, code: 'AUTH',
             error: 'Cannot authenticate with ULIP. Check credentials and that this host is whitelisted.', calls });
  }

  /* ONE ULIP CALL — VAHAN/04 ONLY (user, 2026-10-20: "ULIP is asked twice -> call once only, that's
     VAHAN/04"; ULIP 2026-10-26: VAHAN/01 discontinued, so there is no second format any more). Straight to
     eChallan.app, then Way2API / IDSPay. */
  return backup(regNo, calls, opts, { ok: false, notFound: false, data: null, source: null, code: first.code,
           error: 'The vehicle records source is not responding. Please try again in a few minutes.', calls });
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
  /* eChallan.app MAY START CHARGING ₹1 A CALL (user, 2026-10-08; 10,000 credits
     sponsored for now). echallan_app_paid_only (off) keeps it for paid reports
     too — free checks and background jobs (noBackup) then stop at ULIP. Their
     "pending verification" answers cost nothing either way. */
  const skipFree = opts.skipFreeSource
    || (opts.noBackup && await require('../util/settings').bool('echallan_app_paid_only', false));
  const free = skipFree ? null : await require('../vehicle/echallanApp').rc(regNo).catch((e) => {
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
  /* WAY2API BEFORE IDSPAY (user, 2026-10-21): the same record for ≈ ₹2.40 instead of ₹2.95. Its "not
     found" is final like IDSPay's; any failure (or off, limit, empty wallet) goes on to IDSPay. */
  const w = await require('../vehicle/way2api').lookup(regNo).catch((e) => {
    console.error('[vahan] Way2API threw:', e.message);
    return null;
  });
  if (w) {
    calls.push({ path: 'WAY2API', outcome: w.outcome, code: w.code, ms: w.ms });
    if (w.outcome === 'FOUND') {
      console.warn(`[vahan] ${regNo} served by Way2API after ULIP failed (${failure.code})`);
      return { ok: true, data: w.data, source: 'WAY2API', fallback: true, ulipFailed: true, calls };
    }
    if (w.outcome === 'NOT_FOUND') {
      return { ok: false, notFound: true, data: null, source: 'WAY2API', code: w.code, error: 'Vehicle not found', calls };
    }
  }
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
