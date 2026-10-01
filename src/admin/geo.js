/**
 * src/admin/geo.js — where the vehicles are, by state and RTO (user,
 * 2026-09-25, command center phase 7).
 * ---------------------------------------------------------------------------
 *   states(range)     per state: website visitors, lookups, reports, payments,
 *                     revenue
 *   rtos(state, range) the same per RTO inside one state
 *
 * A vehicle's state and RTO come from its registration number (KA 01 …):
 * reliable, and it says nothing about where the person is. Website visitors
 * are counted by the city-level place kept for them — never finer — and
 * mapped to the same state codes. Payments name their vehicle by
 * raw.vehicle_id.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const command = require('./command');

// State and UT codes as they begin a registration number, with their names.
const STATES = {
  AN: 'Andaman & Nicobar', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar',
  CH: 'Chandigarh', CG: 'Chhattisgarh', DD: 'Dadra & Nagar Haveli and Daman & Diu', DL: 'Delhi', GA: 'Goa',
  GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh', JK: 'Jammu & Kashmir', JH: 'Jharkhand', KA: 'Karnataka',
  KL: 'Kerala', LA: 'Ladakh', LD: 'Lakshadweep', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur',
  ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OD: 'Odisha', PY: 'Puducherry', PB: 'Punjab', RJ: 'Rajasthan',
  SK: 'Sikkim', TN: 'Tamil Nadu', TS: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh', UK: 'Uttarakhand',
  WB: 'West Bengal', BH: 'Bharat series',
};
// Older codes that still appear on plates.
const ALIASES = { OR: 'OD', UA: 'UK', CT: 'CG', TG: 'TS', DN: 'DD' };
const code = (c) => ALIASES[c] || c;
const byName = Object.fromEntries(Object.entries(STATES).map(([c, n]) => [n.toLowerCase(), c]));
byName.orissa = 'OD'; byName.uttaranchal = 'UK'; byName['national capital territory of delhi'] = 'DL';

const REG_STATE = `upper(substring(reg_no from 1 for 2))`;
/*
 * The RTO from a plate (user, 2026-10-01): KA01AB1234 → KA01, and Delhi's
 * one-digit form DL1CAB1234 → DL01, so both match the RTO list (migration 092).
 * Old state codes fold into today's (TG → TS, OR → OD …), as for states.
 */
const RTO = `CASE WHEN reg_no ~ '^[A-Z]{2}[0-9]{2}' THEN upper(substring(reg_no from 1 for 4))
                  WHEN reg_no ~ '^[A-Z]{2}[0-9][A-Z]' THEN upper(substring(reg_no from 1 for 2)) || '0' || substring(reg_no from 3 for 1)
                  ELSE upper(substring(reg_no from 1 for 2)) END`;
const foldRto = (k) => (/^[A-Z]{2}/.test(k) ? `${ALIASES[k.slice(0, 2)] || k.slice(0, 2)}${k.slice(2)}` : k);
/** The same, in code: the RTO a registration number belongs to, or null. */
function rtoCode(reg) {
  const r = String(reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = r.match(/^([A-Z]{2})(\d{2})/) || r.match(/^([A-Z]{2})(\d)[A-Z]/);
  return m ? foldRto(`${m[1]}${m[2].padStart(2, '0')}`) : null;
}

async function perKey(keyExpr, r, stateFilter) {
  const f = stateFilter ? `AND ${REG_STATE} = ANY($3::text[])` : '';
  const args = stateFilter ? [r.from, r.to, stateFilter] : [r.from, r.to];
  const [lookups, reports, money] = await Promise.all([
    db.query(`SELECT ${keyExpr} AS k, count(*)::int AS n FROM events
               WHERE name IN ('vehicle_search_success','vehicle_search_failed') AND reg_no IS NOT NULL
                 AND occurred_at >= $1 AND occurred_at < $2 ${f} GROUP BY 1`, args),
    db.query(`SELECT ${keyExpr} AS k, count(*)::int AS n FROM vehicle_reports
               WHERE created_at >= $1 AND created_at < $2 ${f} GROUP BY 1`, args),
    db.query(`SELECT ${keyExpr.replace(/reg_no/g, 'v.reg_no')} AS k, count(*)::int AS n, sum(p.amount_paise)::int AS paise
                FROM payments p JOIN vehicles v ON v.id = (p.raw->>'vehicle_id')::bigint
               WHERE p.status = 'paid' AND p.paid_at >= $1 AND p.paid_at < $2
                 ${stateFilter ? `AND upper(substring(v.reg_no from 1 for 2)) = ANY($3::text[])` : ''} GROUP BY 1`, args),
  ]);
  const rows = {};
  const at = (k) => (rows[k] = rows[k] || { key: k, visitors: 0, lookups: 0, reports: 0, payments: 0, revenue_paise: 0 });
  for (const x of lookups.rows) at(x.k).lookups += x.n;
  for (const x of reports.rows) at(x.k).reports += x.n;
  for (const x of money.rows) { at(x.k).payments += x.n; at(x.k).revenue_paise += x.paise || 0; }
  return rows;
}

async function states(q = {}) {
  const r = command.resolve(q);
  const raw = await perKey(REG_STATE, r);
  // Fold old codes into today's.
  const rows = {};
  for (const x of Object.values(raw)) {
    const c = code(x.key);
    const t = (rows[c] = rows[c] || { key: c, visitors: 0, lookups: 0, reports: 0, payments: 0, revenue_paise: 0 });
    for (const k of ['lookups', 'reports', 'payments', 'revenue_paise']) t[k] += x[k];
  }
  // Website visitors by the state their city-level place names.
  const { rows: v } = await db.query(
    `SELECT lower(place->>'region') AS region, count(*)::int AS n FROM visitors
      WHERE first_seen_at >= $1 AND first_seen_at < $2 AND place->>'region' IS NOT NULL GROUP BY 1`, [r.from, r.to]);
  let visitorsElsewhere = 0;
  for (const x of v) {
    const c = byName[x.region];
    if (!c) { visitorsElsewhere += x.n; continue; }
    (rows[c] = rows[c] || { key: c, visitors: 0, lookups: 0, reports: 0, payments: 0, revenue_paise: 0 }).visitors += x.n;
  }
  return {
    range: { label: r.label, from: r.from, to: r.to },
    names: STATES,
    states: Object.values(rows).map((x) => ({ ...x, name: STATES[x.key] || x.key })).sort((a, b) => b.lookups - a.lookups || b.visitors - a.visitors),
    visitors_unplaced: visitorsElsewhere,
  };
}

async function rtos(state, q = {}) {
  const c = code(String(state || '').toUpperCase().slice(0, 2));
  if (!/^[A-Z]{2}$/.test(c)) return { rtos: [] };
  const r = command.resolve(q);
  const codes = [c, ...Object.entries(ALIASES).filter(([, to]) => to === c).map(([from]) => from)];
  const raw = await perKey(RTO, r, codes);
  const rows = {};
  for (const x of Object.values(raw)) {
    const k = foldRto(x.key);
    const t = (rows[k] = rows[k] || { key: k, visitors: 0, lookups: 0, reports: 0, payments: 0, revenue_paise: 0 });
    for (const f of ['lookups', 'reports', 'payments', 'revenue_paise']) t[f] += x[f];
  }
  const names = await rtoNames(Object.keys(rows));
  return {
    state: c, name: STATES[c] || c, range: { label: r.label },
    rtos: Object.values(rows).map((x) => ({ ...x, name: names[x.key] || null }))
      .sort((a, b) => b.lookups - a.lookups || b.revenue_paise - a.revenue_paise),
  };
}

/* The name to show for an RTO: the list's office; for a code only a record
   knew, that record's office tidied — "SIRSI RTO, Karnataka" → "Sirsi". */
const NAME = `coalesce(regexp_replace(office, '\\s*\\((previously|formerly|earlier)[^)]*\\)', '', 'gi'), initcap(lower(regexp_replace(regexp_replace(vahan_name, ',.*$', ''),
                       '\\s*\\(?\\y(A?RTO|S?RTO|DTO|RTA|UO)\\y\\)?\\s*$', '', 'i'))))`; /* \\y: a word edge, in PostgreSQL */
async function rtoNames(codes) {
  if (!codes.length) return {};
  const { rows } = await db.query(`SELECT code, ${NAME} AS name FROM rtos WHERE code = ANY($1)`, [codes]);
  return Object.fromEntries(rows.map((r) => [r.code, r.name]));
}

/*
 * EVERY RTO IN INDIA (user, 2026-10-01): the whole list (migration 092, plus
 * codes only the Government record knew), each with this period's activity —
 * zeros included, so it shows where GaadiPe has nobody yet.
 */
async function allRtos(q = {}) {
  const r = command.resolve(q);
  const [list, raw] = await Promise.all([
    db.query(`SELECT code, state_code, ${NAME} AS office, district, notes, source FROM rtos ORDER BY code`),
    perKey(RTO, r),
  ]);
  const act = {};
  for (const x of Object.values(raw)) {
    const k = foldRto(x.key);
    const t = (act[k] = act[k] || { lookups: 0, reports: 0, payments: 0, revenue_paise: 0 });
    for (const f of ['lookups', 'reports', 'payments', 'revenue_paise']) t[f] += x[f];
  }
  const zero = { lookups: 0, reports: 0, payments: 0, revenue_paise: 0 };
  // A code with activity that neither the list nor any record names (a new
  // RTO, or only failed lookups so far): still shown, by its number (user,
  // 2026-10-01). Bharat-series plates have no RTO and are left out.
  const known = new Set(list.rows.map((x) => x.code));
  const unknown = Object.keys(act).filter((k) => /^[A-Z]{2}\d{2}$/.test(k) && !known.has(k) && !k.startsWith('BH'))
    .map((k) => ({ code: k, state_code: k.slice(0, 2), office: null, district: null, notes: null, source: 'activity' }));
  return {
    range: { label: r.label },
    names: STATES,
    rtos: [...list.rows, ...unknown].map((x) => ({
      code: x.code, state: x.state_code, state_name: STATES[x.state_code] || x.state_code,
      office: x.office, district: x.district, notes: x.notes, source: x.source,
      ...(act[x.code] || zero),
    })),
  };
}

/** Ranked rows keyed by an RTO code in `name` (KA01, DL1C…): each gains `office`. */
async function labelRtos(rows) {
  const names = await rtoNames([...new Set(rows.map((r) => rtoCode(r.name)).filter(Boolean))]);
  return rows.map((r) => ({ ...r, office: names[rtoCode(r.name)] || null }));
}

/** The office name for one plate's RTO, or null — for profiles and emails. */
async function rtoNameOf(reg) {
  const c = rtoCode(reg);
  return c ? (await rtoNames([c]))[c] || null : null;
}

module.exports = { states, rtos, allRtos, rtoCode, rtoNames, rtoNameOf, labelRtos, STATES };
