/**
 * src/whatsapp/report.js
 * ---------------------------------------------------------------------------
 * Turn a gateway response into the message a person actually reads.
 *
 * TWO RULES GOVERN THIS FILE.
 *
 * First, problems come before facts. A list of twenty fields is a database
 * dump; nobody reads it, and the one line that mattered — insurance lapsed ten
 * months ago — is buried at position fourteen. So anything expired or expiring
 * is lifted to the top with how long ago or how soon, and everything healthy is
 * compressed underneath. "Expired 10 months ago" produces a reaction;
 * "12-Nov-2025" requires arithmetic nobody does on a phone.
 *
 * Second, some fields are never shown to anyone. The gateway returns
 * owner_name, chassis and engine because ULIP does; they must not leave this
 * file. We cannot verify who owns a vehicle from its number, so showing the
 * owner's name to whoever typed it is indefensible — and a chassis number that
 * has never been displayed stays a shared secret only the real owner knows,
 * which is what makes it usable to verify ownership later. FASTag crossings are
 * withheld for a stronger reason: a crossing history is a movement log.
 * ---------------------------------------------------------------------------
 */

const MS_DAY = 24 * 60 * 60 * 1000;

/**
 * Fields that must never appear in any customer-facing text.
 *
 * Two kinds of thing are listed here. The first identifies the OWNER — name and
 * address — and we cannot verify who owns a vehicle from its number, so showing
 * them to whoever typed it is indefensible.
 *
 * The second is document and asset NUMBERS: chassis, engine, insurance policy,
 * PUCC and permit numbers. These are the credentials used to claim, transfer or
 * renew against the vehicle. Publishing them to anyone who types a plate is how
 * a report becomes an ingredient in a fraud. They also stay useful to us
 * precisely because they were never shown: a number only the real owner knows
 * is the only thing we can later ask for to verify ownership.
 *
 * Expiry DATES are shown, because a date is the whole point of the product and
 * proves nothing about identity. Insurer name is shown, because knowing who to
 * renew with helps the owner and tells a stranger nothing useful.
 */
const NEVER_SHOW = [
  'address', 'owner_category',
  // What the vehicle was bought for. Useful to a buyer, and nobody's business
  // but the owner's — a stranger typing a plate should not learn what someone
  // paid for their car.
  'sale_amount',
  // Chassis and engine are the two that never appear in any form, masked or
  // otherwise. They are the credentials used to transfer or claim against a
  // vehicle, and a number that has never been shown stays something only the
  // real owner knows — which is what makes it usable to verify ownership later.
  'chassis', 'engine',
];

/**
 * Masking: show enough to recognise, never enough to use.
 *
 * An owner checking their own bike wants to see that this is THEIR bike, and a
 * buyer wants to know the seller is the registered owner. A full name serves
 * neither better than a masked one, and serves a stalker considerably better.
 * "SH•••••••• K•" answers "is this the right vehicle and the right person"
 * without publishing who they are to anyone who types a plate.
 *
 * Policy and PUC numbers follow the same rule with their last four digits: a
 * customer matches their own document at a glance, and a stranger gets nothing
 * they could quote to an insurer.
 */
function maskName(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;

  // ULIP already masks owner names at source — "T***L P***R C**********S".
  // Masking that again produces "T*••• P*•••", which is noise on top of noise
  // and looks like a bug. If the source has already done it, pass it through.
  if ((clean.match(/\*/g) || []).length >= 2) return clean;

  return clean.split(/\s+/)
    .map(w => (w.length <= 2 ? w : w.slice(0, 2) + '•'.repeat(Math.min(w.length - 2, 8))))
    .join(' ');
}

function maskNumber(value, keep = 4) {
  const clean = String(value || '').trim();
  if (!clean || clean.length <= keep) return null;
  return '•'.repeat(Math.min(clean.length - keep, 6)) + clean.slice(-keep);
}

/** "HERO MOTOCORP LTD H/H.SPLENDOR PLUS" -> "Hero Motocorp Ltd H/H.Splendor Plus" */
function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

const parseDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const daysUntil = (d) => Math.round((d.getTime() - Date.now()) / MS_DAY);

// Written out rather than toLocaleDateString, which gives "Mar" for one month
// and "Sept" for another in the same message.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) =>
  `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/**
 * "in 24 days" / "10 months ago". Months once past 45 days, because "expired
 * 312 days ago" is a number people have to convert; "10 months ago" lands.
 */
function human(days) {
  const n = Math.abs(days);
  let unit;
  if (n >= 365) {
    // "expired 59 months ago" is a number people have to convert. Years, with
    // a half step, is how anyone would actually say it.
    const years = n / 365;
    const rounded = years >= 2 ? Math.round(years) : Math.round(years * 2) / 2;
    unit = `${rounded} year${rounded === 1 ? '' : 's'}`;
  } else if (n >= 45) {
    const months = Math.round(n / 30);
    unit = `${months} month${months === 1 ? '' : 's'}`;
  } else {
    unit = `${n} day${n === 1 ? '' : 's'}`;
  }
  if (days < 0) return `${unit} ago`;
  if (days === 0) return 'today';
  return `in ${unit}`;
}

const rupees = (paise) => '₹' + Math.round((paise || 0) / 100).toLocaleString('en-IN');

/**
 * The documents worth reporting, in the order they matter to an owner.
 * Permit and fitness are only meaningful for transport vehicles: printing
 * "Permit: not applicable" on every private car is noise that makes the rest
 * look less trustworthy.
 */
function documentsOf(rc) {
  const transport = /TRANSPORT|GOODS|PASSENGER|TAXI|BUS|TRUCK|LORRY|MAXI|TRAILER/i
    .test(`${rc.vehicle_category || ''} ${rc.vehicle_class || ''}`);

  const list = [
    { key: 'insurance_upto', label: 'Insurance' },
    { key: 'pucc_upto',      label: 'PUC' },
    { key: 'reg_upto',       label: 'Registration' },
    { key: 'tax_upto',       label: 'Road tax' },
  ];
  if (transport) {
    list.push({ key: 'fitness_upto', label: 'Fitness' });
    list.push({ key: 'permit_upto',  label: 'Permit' });
  }

  return list
    .map(d => ({ ...d, date: parseDate(rc[d.key]) }))
    .filter(d => d.date)
    .map(d => ({ ...d, days: daysUntil(d.date) }));
}

/** How the vehicle is identified, now that the owner's name is never shown. */
function identity(rc) {
  const bits = [rc.maker, rc.model].filter(Boolean).join(' ');
  const detail = [rc.fuel, rc.manufactured || (rc.reg_date || '').slice(0, 4)]
    .filter(Boolean).join(' · ');
  // registered_at already reads "BENGALURU WEST  RTO, Karnataka"; the numeric
  // rto_code beside it means nothing to an owner. Collapse the double spaces
  // ULIP leaves behind.
  const place = String(rc.registered_at || '').replace(/\s+/g, ' ').trim();
  return [bits, detail, place].filter(Boolean);
}

/**
 * The full message.
 *
 * @param {object} data  a gateway /vehicle/:regNo response
 * @param {number} soonDays  how many days ahead counts as "expiring soon"
 */
/**
 * @param {boolean} detailed  paid vehicles only. A free check answers "is this
 *   vehicle in order?" — identity, expiry dates, challan totals. The paid
 *   report adds who it is registered to, whether there is a loan on it, and the
 *   document numbers to quote when renewing. That is the difference someone is
 *   paying for, so it has to be a difference they can see.
 */
function build(data, { soonDays = 60, owner = 'masked', docNumbers = 'masked',
                       detailed = false } = {}) {
  const rc = data.rc || {};
  const lines = [];

  /* ------------------------------------------------------------- the vehicle */
  lines.push(`🚗 *${data.vehicle_number}*`);

  const name = [rc.maker, rc.model].filter(Boolean).map(titleCase).join(' ');
  if (name) lines.push(`_${name}_`);

  const spec = [
    rc.fuel ? titleCase(rc.fuel) : null,
    rc.vehicle_class ? titleCase(rc.vehicle_class) : null,
    rc.manufactured || (rc.reg_date || '').slice(0, 4),
    rc.colour ? titleCase(rc.colour) : null,
  ].filter(Boolean).join(' · ');
  if (spec) lines.push(spec);

  const place = String(rc.registered_at || '').replace(/\s+/g, ' ').trim();
  if (place) lines.push(`📍 ${titleCase(place)}`);

  // 'masked' by default, 'hidden' to omit entirely, 'full' only if that is ever
  // deliberately chosen. Chassis and engine are NOT settings — they are never
  // shown in any mode, because that is what keeps them usable as the ownership
  // challenge later.
  const ownerLine = !detailed || owner === 'hidden' ? null
    : owner === 'full' ? rc.owner_name
    : maskName(rc.owner_name);
  if (ownerLine) {
    const serial = Number(rc.owner_serial) > 0
      ? ` · ${ORDINAL[rc.owner_serial] || rc.owner_serial + 'th'} owner` : '';
    lines.push(`👤 ${ownerLine}${serial}`);
  } else if (Number(rc.owner_serial) > 0) {
    lines.push(`👤 ${ORDINAL[rc.owner_serial] || rc.owner_serial + 'th'} owner`);
  }
  if (detailed && rc.financer) lines.push(`🏦 Financed · ${titleCase(rc.financer)}`);

  /* --------------------------------------------------------------- documents */
  const docs = documentsOf(rc);
  const bad = docs.filter(d => d.days < 0);
  const soon = docs.filter(d => d.days >= 0 && d.days <= soonDays);
  const fine = docs.filter(d => d.days > soonDays);

  // Extra detail per document, where it helps someone act: which insurer to
  // call, which policy to quote. Numbers are masked to their last four.
  const num = (v) => (!detailed || docNumbers === 'hidden' ? null
    : docNumbers === 'full' ? (v || null) : maskNumber(v));
  const extra = {
    Insurance: [rc.insurance_company ? titleCase(rc.insurance_company) : null,
                num(rc.insurance_policy)].filter(Boolean).join(' · '),
    PUC: num(rc.pucc_number),
    Permit: num(rc.permit_number),
  };
  const detail = (label) => (extra[label] ? `\n   ${extra[label]}` : '');

  if (bad.length || soon.length) {
    lines.push('', '⚠️ *NEEDS ATTENTION*');
    for (const d of bad) {
      lines.push(`❌ *${d.label}* — expired ${human(d.days)}`);
      lines.push(`   ${fmtDate(d.date)}${extra[d.label] ? ` · ${extra[d.label]}` : ''}`);
    }
    for (const d of soon) {
      lines.push(`⏳ *${d.label}* — expires ${human(d.days)}`);
      lines.push(`   ${fmtDate(d.date)}${extra[d.label] ? ` · ${extra[d.label]}` : ''}`);
    }
  }

  if (fine.length) {
    lines.push('', '✅ *VALID*');
    for (const d of fine) {
      lines.push(`• ${d.label} — till ${fmtDate(d.date)}${detail(d.label)}`);
    }
  }

  // Challans: count, total and the most recent date. No locations — a challan
  // location is a place the vehicle was at a time, which is the tracking
  // vector we deliberately do not publish.
  const c = data.challans;
  if (c && (c.pending_count || 0) > 0) {
    lines.push('', '🚨 *CHALLANS*');
    lines.push(`*${c.pending_count} pending* · ${rupees(c.pending_amount_paise)} to pay`);
    const latest = (c.pending || [])[0];
    const when = parseDate(latest?.challan_date || latest?.date);
    if (when) lines.push(`Most recent · ${fmtDate(when)}`);
    if (c.disposed_count) lines.push(`_${c.disposed_count} already paid_`);
  } else if (c) {
    lines.push('', '✅ *CHALLANS* — none pending');
  }

  // FASTag: status and balance only. Never crossings.
  const tag = data.fastag;
  const active = (tag?.tags || []).find(t => /^A/i.test(t.status || t.tag_status || ''))
    || (tag?.tags || [])[0];
  if (active) {
    const on = /^A/i.test(active.status || active.tag_status || '');
    const bal = active.balance != null ? ` · balance ₹${active.balance}` : '';
    lines.push('', `🛣️ *FASTag* — ${on ? 'active' : 'inactive'}${bal}`);
  }

  // Status lines a buyer needs and an owner should know about.
  const flags = [];
  if (/^T|BLACK/i.test(String(rc.blacklist_status || '')) &&
      !/^NA|NONE|^$/i.test(String(rc.blacklist_status))) {
    flags.push(`🚫 Blacklisted · ${titleCase(rc.blacklist_status)}`);
  }
  if (rc.status && !/^ACTIVE/i.test(String(rc.status))) {
    flags.push(`⚠️ RC status · ${titleCase(rc.status)}`);
  }
  if (flags.length) lines.push('', ...flags);

  lines.push('',
    '━━━━━━━━━━━━━━━',
    `_Checked ${fmtDate(new Date(data.fetched_at || Date.now()))} · Government records_`,
    detailed
      ? '_Owner name and document numbers are masked. Chassis and engine numbers are never shown._'
      : '_Chassis, engine and owner details are never shown on a free check._');

  return lines.join('\n');
}

/**
 * One line summarising what needs attention, for the alert template — which
 * cannot contain newlines inside a variable, so items are joined with " · ".
 */
function attentionSummary(data, { soonDays = 30 } = {}) {
  const items = [];
  for (const d of documentsOf(data.rc || {})) {
    if (d.days < 0) items.push(`${d.label} expired ${human(d.days)}`);
    else if (d.days <= soonDays) items.push(`${d.label} expires ${human(d.days)}`);
  }
  const c = data.challans;
  if (c && (c.pending_count || 0) > 0) {
    items.push(`${c.pending_count} pending challan${c.pending_count === 1 ? '' : 's'} ${rupees(c.pending_amount_paise)}`);
  }
  return items.join(' · ');
}

/** Strip anything that must never be shown, before logging or forwarding. */
function safeRc(rc) {
  const out = { ...(rc || {}) };
  for (const k of NEVER_SHOW) delete out[k];
  return out;
}

/** build(), with the display modes read from settings. */
async function buildFor(data, opts = {}) {
  const settings = require('../util/settings');
  return build(data, {
    ...opts,
    owner: await settings.get('owner_name_display', 'masked'),
    docNumbers: await settings.get('document_numbers_display', 'masked'),
  });
}

module.exports = { build, buildFor, attentionSummary, safeRc, documentsOf, human,
                   maskName, maskNumber, titleCase, NEVER_SHOW };
