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

/** Fields that must never appear in any customer-facing text. */
const NEVER_SHOW = ['owner_name', 'chassis', 'engine', 'address', 'owner_category'];

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
function build(data, { soonDays = 60 } = {}) {
  const rc = data.rc || {};
  const lines = [];

  lines.push(`🚗 *${data.vehicle_number}*`);
  for (const l of identity(rc)) lines.push(l);

  const docs = documentsOf(rc);
  const bad = docs.filter(d => d.days < 0);
  const soon = docs.filter(d => d.days >= 0 && d.days <= soonDays);
  const fine = docs.filter(d => d.days > soonDays);

  if (bad.length || soon.length) {
    lines.push('', '⚠️ *NEEDS ATTENTION*');
    for (const d of bad) lines.push(`❌ ${d.label} — expired ${human(d.days)} (${fmtDate(d.date)})`);
    for (const d of soon) lines.push(`⏳ ${d.label} — expires ${human(d.days)} (${fmtDate(d.date)})`);
  }

  if (fine.length) {
    lines.push('', '✅ *IN ORDER*');
    for (const d of fine) lines.push(`${d.label} valid till ${fmtDate(d.date)}`);
  }

  // Challans: count, total and the most recent date. No locations — a challan
  // location is a place the vehicle was at a time, which is the tracking
  // vector we deliberately do not publish.
  const c = data.challans;
  if (c && (c.pending_count || 0) > 0) {
    lines.push('', '🚨 *CHALLANS*');
    lines.push(`${c.pending_count} pending · ${rupees(c.pending_amount_paise)} total`);
    const latest = (c.pending || [])[0];
    const when = parseDate(latest?.challan_date || latest?.date);
    if (when) lines.push(`Most recent: ${fmtDate(when)}`);
  } else if (c) {
    lines.push('', '✅ No pending challans');
  }

  // FASTag: status and balance only. Never crossings.
  const tag = data.fastag;
  const active = (tag?.tags || []).find(t => /^A/i.test(t.status || t.tag_status || ''))
    || (tag?.tags || [])[0];
  if (active) {
    const bal = active.balance != null ? ` · balance ₹${active.balance}` : '';
    lines.push('', `🛣️ FASTag ${/^A/i.test(active.status || active.tag_status || '') ? 'active' : 'inactive'}${bal}`);
  }

  lines.push('', `_Data as on ${fmtDate(new Date(data.fetched_at || Date.now()))}, from Government records._`);

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

module.exports = { build, attentionSummary, safeRc, documentsOf, human, NEVER_SHOW };
