/**
 * src/site/vehicleView.js — what the website is allowed to show about a vehicle.
 *
 * ONE PLACE DECIDES, because "basic before paying, full after" is the product,
 * and a second implementation of that rule is how a free check quietly starts
 * showing paid detail.
 *
 * The rules:
 *   masked, paid only  the owner's name (as ULIP stars it), chassis and engine
 *                      (first character only) — as on Parivahan (user, 2026-10-01)
 *   never, to anyone   address, contact, FASTag crossings
 *   free               what the vehicle is, and WHICH documents have lapsed
 *   paid               every date, the challan list, financer, blacklist, NOC,
 *                      document references and FASTag
 */

const report = require('../whatsapp/report');

const maskNumber = report.maskNumber;

/**
 * The free view: enough to know this is the right vehicle, and nothing else.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY. An earlier version gave away every
 * expiry date, the challan total and whether a financer was recorded — which is
 * the entire report. Somebody who can already read "PUC expired, 3 challans,
 * loan recorded" has no reason left to pay, and a free check that answers the
 * question is not a funnel, it is the product given away.
 *
 * So the free check answers two questions and stops. Is this the vehicle I am
 * looking at — maker, model and variant, fuel and class. And is anything
 * plainly wrong with it — which documents have lapsed, by name.
 *
 * A NAME WITHOUT A DATE cannot be acted on. "Insurance expired" is a fact a
 * buyer is entitled to before paying, and it is what makes the free check worth
 * running; when it expired, what else is due, what the challans come to and
 * whether there is a loan on it are the report.
 */
function basic(data, { detail = 'count' } = {}) {
  if (detail === 'public') return publicView(data);
  const rc = data.rc || {};
  const c = data.challans || {};
  const docs = report.documentsOf(rc);
  const expired = docs.filter((d) => d.days < 0).map((d) => d.label);
  const dueSoon = docs.filter((d) => d.days >= 0 && d.days <= 60).map((d) => d.label);
  const pending = c.pending_count ?? 0;
  // How many things are wrong, counted but not named.
  const attention = expired.length + dueSoon.length + (pending > 0 ? 1 : 0);

  return {
    reg_no: data.vehicle_number,
    pretty: data.vehicle_number_pretty || data.vehicle_number,
    paid: false,
    identity: {
      maker: rc.maker || null,
      // VAHAN carries the variant inside the model ("H/H.SPLENDOR PLUS"), so
      // the two are one field rather than an invented split.
      model: rc.model || null,
      // With free_view_detail 'none' (the free look before sign-in, 2026-10-08:
      // "show only make, model, variant") nothing else about the vehicle.
      vehicle_class: detail === 'none' ? null : (rc.vehicle_class || null),
      fuel: detail === 'none' ? null : (rc.fuel || null),
    },
    /*
     * WHAT is wrong, never WHEN or BY HOW MUCH.
     *
     * "Insurance expired" is a fact a buyer is entitled to before paying, and
     * saying it plainly is what makes the check worth running. The date it
     * expired, how long ago, the policy behind it and what else is due — those
     * are the report. A label without a date cannot be acted on: it can only be
     * verified by buying, or by asking the seller a much better question.
     */
    /*
     * HOW MUCH THE FREE CHECK GIVES AWAY (user, 2026-09-22), by free_view_detail:
     *   labels  which documents lapsed, by name, and the challan count
     *   count   only how many things need attention
     *   none    nothing about what is wrong — identity only
     * Naming them answered the buyer's question for free, and they left.
     */
    detail,
    found: detail === 'none' ? { has_record: docs.length > 0 } : detail === 'count' ? {
      needs_attention: attention,
      documents_total: docs.length,
      has_record: docs.length > 0,
    } : {
      expired,
      due_soon: dueSoon,
      documents_total: docs.length,
      challans_pending: pending,
      has_record: docs.length > 0,
    },
    /* Named so the buyer knows what they are buying — with no answers in it. */
    locked: [
      'Loan / hypothecation status',
      'Blacklist and NOC status',
      'Insurance, PUC, road tax, fitness and permit validity',
      'Every challan, with its offence, place and amount',
      'Insurer, policy and PUC references',
      'FASTag status and balance',
      'RTO, registration date and how many owners',
    ],
    checked_at: data.fetched_at || new Date().toISOString(),
  };
}

/*
 * THE FREE CHECK BEFORE SIGN-IN (user, 2026-10-08): make, model NAME and fuel —
 * the variant hidden. VAHAN sends model and variant as one text ("SELTOS D1.5
 * 6AT HTX PLUS", "H/H.SPLENDOR PLUS"), so the first word of the model, after
 * cleaning a maker prefix like "H/H.", is the name and the rest is hidden.
 * Two-word names ("SWIFT DZIRE") show their first word only: never more than
 * meant. Nothing else about the vehicle is in it.
 */
function modelName(model) {
  const words = String(model || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { name: null, hidden: false };
  // "H/H.SPLENDOR" -> "SPLENDOR"; "M/S.XYZ" -> "XYZ".
  const first = words[0].replace(/^[A-Z0-9]{1,3}\/[A-Z0-9]{1,3}\.?/i, '').replace(/^[^A-Z0-9]+/i, '') || words[0];
  return { name: first, hidden: words.length > 1 || first !== words[0] };
}

/*
 * BEFORE SIGN-IN, LIKE CARINFO (user, 2026-10-10: "carinfo.app shows this before
 * login" — make and model with variant, the owner's name masked, RTO details).
 * Each extra is a setting (free_check_show_variant / _owner, read by site/chat.js);
 * the RTO is added there too (rtoOf, it needs the database).
 */
/* VAHAN's model without the maker's code in front: "H/H.SPLENDOR PLUS" -> "SPLENDOR PLUS". */
const cleanModel = (model) => (String(model || '').trim().replace(/^[A-Z0-9]{1,3}\/[A-Z0-9]{1,3}\.?\s*/i, '').trim() || null);

function identity(data, { variant = false, owner = false } = {}) {
  const rc = data.rc || {};
  const m = modelName(rc.model);
  return {
    reg_no: data.vehicle_number,
    paid: false,
    detail: 'identity',
    identity: {
      maker: rc.maker || null,
      model: variant ? (cleanModel(rc.model) || m.name) : m.name,
      variant_hidden: variant ? false : m.hidden,
      fuel: rc.fuel || null,
      vehicle_class: rc.vehicle_class || null,
      owner_masked: owner ? report.maskName(rc.owner_name) : null,
    },
    checked_at: data.fetched_at || new Date().toISOString(),
  };
}

/*
 * SIGNED IN, FREE — THE PUBLIC RECORD (user, 2026-10-10: CarInfo shows this after
 * login, free_view_detail = 'public'). What the Government's own Parivahan shows:
 * the vehicle, the owner's name masked, every validity DATE, its age, norms,
 * seats, weight, RC status — and how many challans are pending, not which.
 *
 * WHAT STAYS IN THE ₹19 REPORT: the loan / financer, blacklist and NOC, every
 * challan with its amount, how many owners, insurer and policy, chassis and
 * engine, FASTag, the buyer's verdict, the PDF and 28 days of alerts.
 */
function publicView(data) {
  const rc = data.rc || {};
  const c = data.challans || {};
  const docs = report.documentsOf(rc);
  return {
    reg_no: data.vehicle_number,
    pretty: data.vehicle_number_pretty || data.vehicle_number,
    paid: false,
    detail: 'public',
    identity: {
      maker: rc.maker || null,
      model: cleanModel(rc.model),
      vehicle_class: rc.vehicle_class || null,
      fuel: rc.fuel || null,
      norms: rc.norms || null,
      seats: rc.seats ?? null,
      unladen_weight: rc.unladen_weight ?? null,
      reg_date: rc.reg_date || null,
      rc_status: rc.status || null,
      owner_masked: report.maskName(rc.owner_name),
    },
    documents: docs.map((d) => ({
      label: d.label,
      name: d.name,
      valid_until: d.date instanceof Date ? d.date.toISOString().slice(0, 10) : d.date,
      days: d.days,
      state: d.days < 0 ? 'expired' : d.days <= 30 ? 'due' : 'valid',
    })),
    found: {
      expired: docs.filter((d) => d.days < 0).map((d) => d.label),
      due_soon: docs.filter((d) => d.days >= 0 && d.days <= 60).map((d) => d.label),
      challans_pending: c.pending_count ?? 0,
      documents_total: docs.length,
      has_record: docs.length > 0,
    },
    locked: [
      'Loan / hypothecation (financer)',
      'Blacklist and NOC status',
      'Every challan, with offence, place and amount',
      'How many owners the vehicle has had',
      'Insurer and policy, chassis and engine (masked)',
      'FASTag status',
      'A clear verdict: what to check before you pay',
      'PDF report + 28 days of alerts',
    ],
    checked_at: data.fetched_at || new Date().toISOString(),
  };
}

/*
 * THE RTO, FROM THE NUMBER ALONE — free, the same for every vehicle of that
 * office (code, office, district, state). Not from the vehicle's record.
 */
async function rtoOf(regNo) {
  const geo = require('../admin/geo');
  const code = geo.rtoCode(regNo);
  if (!code) return null;
  const row = await require('../db').one(
    `SELECT code, state_code, office, district FROM rtos WHERE code = $1`, [code]).catch(() => null);
  const state = row?.state_code || code.slice(0, 2);
  return {
    code: `${code.slice(0, 2)}-${code.slice(2)}`,
    office: row?.office ? row.office.replace(/\s*\((previously|formerly|earlier)[^)]*\)/gi, '').trim() : null,
    district: row?.district && row.district.length <= 60 ? row.district : null,
    state: geo.STATES[state] || state,
    website: 'https://parivahan.gov.in',
  };
}

/*
 * THE BUYER'S VERDICT (user, 2026-10-10: what the ₹19 sells that a data app does
 * not — what to DO). Plain rules on the record already fetched; no extra call.
 * tone: wrong (stop and check), watch (ask the seller), good (clear).
 */
function verdict(data) {
  const rc = data.rc || {};
  const c = data.challans || {};
  const out = [];
  const rs = (p) => `₹${Math.round(Number(p || 0) / 100).toLocaleString('en-IN')}`;
  const none = (v) => !v || /^(na|n\/a|none|nil|no|not available|-)$/i.test(String(v).trim());
  if (!none(rc.blacklist_status)) {
    out.push({ tone: 'wrong', text: `Blacklist: ${rc.blacklist_status}. Do not buy until the RTO clears it.` });
  }
  if (!none(rc.financer)) {
    // "CENTURION BANK LTD.,." -> "Centurion Bank Ltd" (the sentence supplies the full stop)
    const bank = String(rc.financer).trim().replace(/[\s,;.]+$/, '').toLowerCase()
      .replace(/\b([a-z])/g, (m) => m.toUpperCase());
    out.push({ tone: 'wrong', text: `Loan recorded with ${bank}. Before paying, get the bank's NOC and Form 35 so the loan can be removed from the RC.` });
  }
  const pending = c.pending_count ?? 0;
  if (pending > 0) {
    out.push({ tone: 'watch', text: `${pending} challan${pending === 1 ? '' : 's'} pending${c.pending_amount_paise ? ` (${rs(c.pending_amount_paise)})` : ''}. Ask the seller to clear them before the RC transfer.` });
  }
  if (rc.status && !/^active$/i.test(String(rc.status).trim())) {
    out.push({ tone: 'watch', text: `RC status: ${rc.status}. Ask the seller to explain and fix it at the RTO before you buy.` });
  }
  for (const d of report.documentsOf(rc)) {
    if (d.days < 0) out.push({ tone: 'watch', text: `${d.name || d.label} expired ${Math.abs(d.days)} day${Math.abs(d.days) === 1 ? '' : 's'} ago. The vehicle should not be driven until it is renewed.` });
    else if (d.days <= 30) out.push({ tone: 'watch', text: `${d.name || d.label} ends in ${d.days} day${d.days === 1 ? '' : 's'}. Budget for the renewal.` });
  }
  const owners = Number(rc.owner_serial || 0);
  if (owners >= 3) out.push({ tone: 'watch', text: `This vehicle has had ${owners} owners. Check the service record and the condition carefully.` });
  if (!out.length) out.push({ tone: 'good', text: 'No loan, no blacklist, no pending challans and every document valid on the Government record.' });
  return out;
}

/** The paid view: everything the report holds, with the same masking. */
function full(data) {
  const rc = data.rc || {};
  const c = data.challans || {};
  const tag = (data.fastag?.tags || []).find(t => /^A/i.test(t.status || t.tag_status || ''))
    || (data.fastag?.tags || [])[0] || null;

  const out = {
    reg_no: data.vehicle_number,
    pretty: data.vehicle_number_pretty || data.vehicle_number,
    paid: true,
    locked: null,
    identity: {
      maker: rc.maker || null,
      model: cleanModel(rc.model) || rc.model || null,
      vehicle_class: rc.vehicle_class || null,
      fuel: rc.fuel || null,
      colour: rc.colour || null,
      manufactured: rc.manufactured || null,
      registered_at: rc.registered_at || null,
      reg_date: rc.reg_date || null,
      rc_status: rc.status || null,
      owner_serial: rc.owner_serial ?? null,
      cubic_capacity: rc.cubic_capacity ?? null,
      seats: rc.seats ?? null,
      norms: rc.norms || null,
    },
    documents: report.documentsOf(rc).map(d => ({
      label: d.label,
      name: d.name,          // what to show: "PUC (emission test)"
      valid_until: d.date instanceof Date ? d.date.toISOString().slice(0, 10) : d.date,
      days: d.days,
      state: d.days < 0 ? 'expired' : d.days <= 30 ? 'due' : 'valid',
    })),
    fastag: tag ? {
      active: /^A/i.test(tag.status || tag.tag_status || ''),
      balance: tag.balance ?? null,
      issued_on: tag.issue_date || null,
      // Every tag on record, active first — one vehicle often has an old closed
      // tag and a live one, and showing only one misleads either way.
      tags: (data.fastag?.tags || []).map((t) => ({
        // The tag's number is an identifier: last four only (2026-10-08).
        tag_id: maskNumber(t.tag_id || t.tid || null),
        status: t.status || t.tag_status || null,
        active: t.is_active === true || /^A/i.test(t.status || t.tag_status || ''),
        issued_on: t.issue_date || null,
        vehicle_class: t.vehicle_class || null,
        bank: t.bank_id || null,
      })).sort((a, b) => Number(b.active) - Number(a.active)),
    } : null,
    checked_at: data.fetched_at || new Date().toISOString(),
  };

  out.ownership = {
    owner_masked: report.maskName(rc.owner_name),
    chassis_masked: report.maskFirst(rc.chassis),
    engine_masked: report.maskFirst(rc.engine),
    owner_serial: rc.owner_serial ?? null,
    owner_type: rc.owner_type || null,
    financer: rc.financer || null,
    blacklist_status: rc.blacklist_status || null,
    noc_details: rc.noc_details || null,
    noc_date: rc.noc_date || null,
  };

  out.references = {
    insurance_company: rc.insurance_company || null,
    insurance_policy: maskNumber(rc.insurance_policy),
    pucc_number: maskNumber(rc.pucc_number),
    permit_number: maskNumber(rc.permit_number),
    permit_type: rc.permit_type || null,
  };

  out.verdict = verdict(data);

  out.challans = {
    pending_count: c.pending_count ?? 0,
    pending_amount_paise: c.pending_amount_paise ?? null,
    disposed_count: c.disposed_count ?? 0,
    locked: false,
    disposed_amount_paise: c.disposed_amount_paise ?? null,
    summary: c.summary || null,
    pending: (c.pending || []).map(one),
    disposed: (c.disposed || []).slice(0, 50).map(one),
    truncated: Boolean(c.truncated),
  };

  return out;
}

/* A challan, without the tracking. Location is kept because it is what makes a
   challan recognisable to its owner; the time of day is not. */
const one = (p) => ({
  challan_no: p.challan_no || null,
  date: p.challan_date || null,
  offence: p.offence || (p.offences || []).map(o => o.name).join('; ') || null,
  place: p.place || null,
  amount_paise: p.amount_paise ?? null,
  status: p.sent_to_court || p.sent_to_virtual_court ? 'In court' : (p.status || 'Pending'),
});

module.exports = { basic, full, identity, modelName, rtoOf, verdict, publicView, cleanModel };
