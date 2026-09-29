/**
 * src/fleet/status.js — what each fleet vehicle looks like today (user,
 * 2026-09-29). Read from the vehicle's stored snapshots (the daily check keeps
 * them fresh), never from a new lookup: building the report costs nothing.
 *
 * Every document is a cell with a state the Excel colours and the email counts:
 *   valid · due (within 30 days) · expired · na (not needed for this vehicle)
 *   · missing (not on the record)
 */

const db = require('../db');
const report = require('../whatsapp/report');

const DUE_DAYS = 30;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (d) => `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/* The columns, in the order a fleet owner cares about. `transport` ones only
   apply to commercial vehicles. */
const COLUMNS = [
  { label: 'Insurance',    name: 'Insurance' },
  { label: 'PUC',          name: 'PUC (emission test)' },
  { label: 'Road tax',     name: 'Road tax' },
  { label: 'Fitness',      name: 'Fitness', transport: true },
  { label: 'Permit',       name: 'Permit', transport: true },
  { label: 'Registration', name: 'Registration' },
];

const isTransport = (rc) => /TRANSPORT|GOODS|PASSENGER|TAXI|BUS|TRUCK|LORRY|MAXI|TRAILER/i
  .test(`${rc.vehicle_category || ''} ${rc.vehicle_class || ''}`);
const present = (v) => v && !/^(NA|N\/A|NONE|NULL|-|—)$/i.test(String(v).trim());

function docCell(col, rc, byLabel) {
  const d = byLabel.get(col.label);
  if (!d) {
    if (col.transport && !isTransport(rc)) return { state: 'na', text: 'Not needed' };
    return { state: 'missing', text: 'Not on record' };
  }
  const when = fmt(d.date);
  if (d.days < 0) return { state: 'expired', text: `Expired ${when}`, days: d.days, date: d.date };
  if (d.days <= DUE_DAYS) return { state: 'due', text: `${when} (${d.days === 0 ? 'today' : `${d.days} day${d.days === 1 ? '' : 's'}`})`, days: d.days, date: d.date };
  return { state: 'valid', text: when, days: d.days, date: d.date };
}

/** One vehicle, from its fleet_vehicles row (vehicle_id may still be empty). */
async function vehicleStatus(fv) {
  const snaps = fv.vehicle_id ? (await db.query(
    `SELECT dataset, data, fetched_at FROM vehicle_snapshots WHERE vehicle_id = $1`, [fv.vehicle_id])).rows : [];
  const by = Object.fromEntries(snaps.map((s) => [s.dataset, s]));
  const rc = by.rc?.data || {};
  const ch = by.challan?.data || null;
  const checked = !!by.rc && fv.last_checked_at;

  const byLabel = new Map(report.documentsOf(rc).map((d) => [d.label, d]));
  const docs = Object.fromEntries(COLUMNS.map((c) => [c.label, docCell(c, rc, byLabel)]));

  const pending = ch ? Number(ch.pending_count || 0) : null;
  const blacklisted = /^T|BLACK/i.test(String(rc.blacklist_status || '')) && !/^NA|NONE|^$/i.test(String(rc.blacklist_status || ''));
  const rcInactive = rc.status && !/^ACTIVE/i.test(String(rc.status));

  // Each issue has a stable `key` (what it is) and a `name` (what to call it
  // once resolved), so tomorrow's email can say what changed.
  const issues = [];
  for (const c of COLUMNS) {
    const d = docs[c.label];
    if (d.state === 'expired') issues.push({ key: `${c.label}:expired`, name: c.name, level: 3, text: `${c.name} expired on ${fmt(d.date)}`, days: d.days });
    else if (d.state === 'due') issues.push({ key: `${c.label}:due`, name: c.name, level: 2, text: `${c.name} expires ${d.days === 0 ? 'today' : `in ${d.days} day${d.days === 1 ? '' : 's'}`} (${fmt(d.date)})`, days: d.days });
  }
  if (pending > 0) issues.push({ key: 'challans', name: 'Challans', level: 2, text: `${pending} pending challan${pending === 1 ? '' : 's'} · ₹${Math.round((ch.pending_amount_paise || 0) / 100).toLocaleString('en-IN')}` });
  if (blacklisted) issues.push({ key: 'blacklist', name: 'Blacklist', level: 3, text: 'Blacklisted by the RTO' });
  if (rcInactive) issues.push({ key: 'rc', name: 'RC status', level: 3, text: `RC status: ${rc.status}` });

  return {
    reg_no: fv.reg_no,
    title: [rc.maker, rc.model].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || null,
    vehicle_class: rc.vehicle_class || null,
    checked: Boolean(checked),
    checked_at: fv.last_checked_at || by.rc?.fetched_at || null,
    docs,
    challans: ch,                      // null = never answered
    pending,
    pending_paise: ch ? Number(ch.pending_amount_paise || 0) : null,
    blacklisted,
    loan: present(rc.financer) ? String(rc.financer) : null,
    rc_status: rc.status || null,
    issues: issues.sort((a, b) => b.level - a.level || (a.days ?? 99999) - (b.days ?? 99999)),
    state: !checked ? 'unchecked' : issues.some((i) => i.level === 3) ? 'expired' : issues.length ? 'attention' : 'ok',
  };
}

/** Every live vehicle of a fleet. */
async function fleetStatus(fleetId) {
  const { rows } = await db.query(
    `SELECT * FROM fleet_vehicles WHERE fleet_id = $1 AND removed_at IS NULL ORDER BY reg_no`, [fleetId]);
  const out = [];
  for (const fv of rows) out.push(await vehicleStatus(fv));
  return out;
}

/** The small per-vehicle picture kept with each day's report, to say what changed. */
const snapshotOf = (list) => Object.fromEntries(list.map((v) => [v.reg_no, {
  pending: v.pending,
  issues: Object.fromEntries(v.issues.filter((i) => i.key !== 'challans').map((i) => [i.key, i.name])),
}]));

/** What is different from the last report: new vehicles, new problems, fixed ones, new challans. */
function changesSince(prev, list) {
  if (!prev) return [];
  const out = [];
  for (const v of list) {
    const p = prev[v.reg_no];
    if (!p) { out.push(`${v.reg_no}: added to your fleet`); continue; }
    if (v.pending != null && p.pending != null && v.pending !== p.pending) {
      const n = Math.abs(v.pending - p.pending);
      out.push(`${v.reg_no}: ${n} ${v.pending > p.pending ? 'new' : ''} challan${n === 1 ? '' : 's'}${v.pending > p.pending ? '' : ' cleared'}`.replace('  ', ' '));
    }
    const was = p.issues || {};
    for (const i of v.issues) if (i.key !== 'challans' && !was[i.key]) out.push(`${v.reg_no}: ${i.text}`);
    for (const [key, name] of Object.entries(was)) {
      if (!v.issues.some((i) => i.key === key) && !(key.endsWith(':due') && v.issues.some((i) => i.key === key.replace(':due', ':expired')))) {
        out.push(`${v.reg_no}: ${name} — renewed / resolved ✅`);
      }
    }
  }
  for (const reg of Object.keys(prev)) if (!list.some((v) => v.reg_no === reg)) out.push(`${reg}: removed from your fleet`);
  return out;
}

module.exports = { COLUMNS, vehicleStatus, fleetStatus, snapshotOf, changesSince, fmt };
