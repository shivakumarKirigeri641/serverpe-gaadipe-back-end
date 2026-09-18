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

/**
 * The free view: enough to know this is the right vehicle, and nothing else.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY. An earlier version gave away every
 * expiry date, the challan total and whether a financer was recorded — which is
 * the entire report. Somebody who can already read "PUC expired, 3 challans,
 * loan recorded" has no reason left to pay, and a free check that answers the
 * question is not a funnel, it is the product given away.
 *
 * So the free check answers one question only: is this the vehicle I am looking
 * at? Maker, model and variant, fuel and class. Then it says HOW MANY things
 * need attention — enough to know it matters, never enough to act on.
 *
 * Counts are not values: "2 documents need attention" tells nobody which, or
 * when, or what it will cost to put right.
 */
function basic(data) {
  const rc = data.rc || {};
  const c = data.challans || {};
  const docs = report.documentsOf(rc);

  return {
    reg_no: data.vehicle_number,
    pretty: data.vehicle_number_pretty || data.vehicle_number,
    paid: false,
    identity: {
      maker: rc.maker || null,
      // VAHAN carries the variant inside the model ("H/H.SPLENDOR PLUS"), so
      // the two are one field rather than an invented split.
      model: rc.model || null,
      vehicle_class: rc.vehicle_class || null,
      fuel: rc.fuel || null,
    },
    /* How much is wrong, never what. */
    found: {
      documents_expired: docs.filter(d => d.days < 0).length,
      documents_due: docs.filter(d => d.days >= 0 && d.days <= 60).length,
      documents_total: docs.length,
      challans_pending: c.pending_count ?? 0,
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
    fastag: tag ? {
      active: /^A/i.test(tag.status || tag.tag_status || ''),
      balance: tag.balance ?? null,
      issued_on: tag.issue_date || null,
    } : null,
    checked_at: data.fetched_at || new Date().toISOString(),
  };

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

module.exports = { basic, full };
