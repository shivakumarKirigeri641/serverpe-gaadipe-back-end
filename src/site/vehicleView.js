/**
 * src/site/vehicleView.js — what the website is allowed to show about a vehicle.
 *
 * ONE PLACE DECIDES, because "basic before paying, full after" is the product,
 * and a second implementation of that rule is how a free check quietly starts
 * showing paid detail.
 *
 * The rules are the same ones the WhatsApp report follows:
 *   never, to anyone   chassis, engine, the owner's name
 *   free               identity, document expiry dates, challan and FASTag totals
 *   paid               financer, blacklist and NOC, masked document numbers,
 *                      the challan list with offence and place
 */

const report = require('../whatsapp/report');

const maskNumber = report.maskNumber;

/** The basic view: enough to know whether the vehicle is in order. */
function basic(data) {
  const rc = data.rc || {};
  const c = data.challans || {};
  const tag = (data.fastag?.tags || []).find(t => /^A/i.test(t.status || t.tag_status || ''))
    || (data.fastag?.tags || [])[0] || null;

  return {
    reg_no: data.vehicle_number,
    pretty: data.vehicle_number_pretty || data.vehicle_number,
    paid: false,
    identity: {
      maker: rc.maker || null,
      model: rc.model || null,
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
      valid_until: d.date instanceof Date ? d.date.toISOString().slice(0, 10) : d.date,
      days: d.days,
      state: d.days < 0 ? 'expired' : d.days <= 30 ? 'due' : 'valid',
    })),
    challans: {
      pending_count: c.pending_count ?? null,
      pending_amount_paise: c.pending_amount_paise ?? null,
      disposed_count: c.disposed_count ?? null,
      // The list itself is what the report is for.
      locked: (c.pending_count || 0) > 0,
    },
    fastag: tag ? {
      active: /^A/i.test(tag.status || tag.tag_status || ''),
      balance: tag.balance ?? null,
      issued_on: tag.issue_date || null,
    } : null,
    // What paying adds, named rather than hinted at, and only where there is
    // something real behind it.
    locked: {
      financer: Boolean(rc.financer),
      blacklist: Boolean(rc.blacklist_status && !/^(NA|NONE|-)$/i.test(String(rc.blacklist_status))),
      noc: Boolean(rc.noc_details && !/^(NA|NONE|-)$/i.test(String(rc.noc_details))),
      challan_details: (c.pending_count || 0) > 0,
      document_numbers: Boolean(rc.insurance_policy || rc.pucc_number || rc.permit_number),
    },
    checked_at: data.fetched_at || new Date().toISOString(),
  };
}

/** The paid view: everything the report holds, with the same masking. */
function full(data) {
  const rc = data.rc || {};
  const c = data.challans || {};
  const out = basic(data);
  out.paid = true;
  out.locked = null;

  out.ownership = {
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

  out.challans = {
    ...out.challans,
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

module.exports = { basic, full };
