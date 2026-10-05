/**
 * src/vehicle/rcBackup.js — the paid RC source used only when ULIP's VAHAN
 * fails (user, 2026-10-02: "automatic switching if ULIP fails, otherwise go
 * for ULIP").
 *
 *   ULIP VAHAN answers            -> ULIP's answer, nothing spent here
 *   ULIP says "not found" (231)   -> final; never asked here
 *   ULIP fails any other way      -> asked here, ₹3 a call (setting)
 *
 * THE PROVIDER: IDSPay RC validation (user, 2026-10-02) —
 *   POST https://javabackend.idspay.in/api/v1/prod/srv2/validation/rc
 *   body { api_id, api_key, token_id, reg_no }; success is status.code 200.
 *   Their answer is NOT masked (full owner name, chassis, engine, address).
 *
 * GUARDS
 *   rc_backup flag              off by default; switch on in Feature flags
 *   API_ID / API_KEY / TOKEN_ID in .env on the server; without them it is off
 *                               (RC_BACKUP_URL overrides the address)
 *   rc_backup_daily_limit       calls per IST day (default 200 = ₹600); past
 *                               it, ULIP's failure stands and customers are
 *                               put on the waiting list as before
 *
 * PRIVACY: a paid source may return what ULIP masks. Everything is masked
 * HERE, to ULIP's level, before it leaves this file — owner name starred,
 * the last five characters of chassis and engine starred, the address cut to
 * its pincode — so the reports, the website and the Terms stay true whichever
 * source answered.
 *
 * Cost: each call is recorded with provider_path 'RCBACKUP' and priced from
 * rc_backup_cost_paise (vehicle/store.js); the status strip has its own light.
 */

const db = require('../db');
const settings = require('../util/settings');
const status = require('../util/providerStatus');

const PATH = 'RCBACKUP';

const URL_ = () => String(process.env.RC_BACKUP_URL || 'https://javabackend.idspay.in/api/v1/prod/srv2/validation/rc').trim();
const CREDS = () => ({ id: String(process.env.API_ID || '').trim(), key: String(process.env.API_KEY || '').trim(), token: String(process.env.TOKEN_ID || '').trim() });
const configured = () => { const c = CREDS(); return Boolean(c.id && c.key && c.token); };

async function enabled() {
  return configured() && require('../util/flags').on('rc_backup');
}

/** Calls made today (IST), and whether another is allowed. */
async function today() {
  const row = await db.one(
    `SELECT count(*)::int AS n FROM event_log
      WHERE kind = 'rc_backup_call'
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`);
  const limit = await settings.num('rc_backup_daily_limit', 200);
  return { used: row?.n || 0, limit, left: Math.max(0, limit - (row?.n || 0)) };
}

/* ───────────────────────── masking, to ULIP's level ───────────────────────── */

/** "RAMESH KUMAR" -> "R****H K***R", as ULIP stars a name. Already starred stays. */
function maskName(v) {
  const s = String(v || '').trim();
  if (!s || s.includes('*')) return s || null;
  return s.split(/\s+/).map((w) => (w.length <= 2 ? `${w[0]}*` : `${w[0]}${'*'.repeat(w.length - 2)}${w[w.length - 1]}`)).join(' ');
}
/** The last five characters starred, as ULIP does for chassis and engine. */
function maskTail(v) {
  const s = String(v || '').replace(/\s+/g, '').toUpperCase();
  if (!s) return null;
  if (s.includes('*')) return s;
  return s.length <= 5 ? '*'.repeat(s.length) : s.slice(0, -5) + '*****';
}
/** ULIP gives the address as district + pincode; we keep only the pincode. */
function maskAddress(v) {
  const pin = /\b\d{6}\b/.exec(String(v || ''));
  return pin ? pin[0] : null;
}

/* ───────────────────────── IDSPay ───────────────────────── */

async function request(regNo) {
  const c = CREDS();
  const res = await fetch(URL_(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    // The id goes under both spellings: the note we were given said "apid_id".
    body: JSON.stringify({ api_id: c.id, apid_id: c.id, api_key: c.key, token_id: c.token, reg_no: regNo }),
    signal: AbortSignal.timeout(Number(process.env.RC_BACKUP_TIMEOUT_MS) || 25000),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 200) }; }
  return { http: res.status, json };
}

const val = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' || /^(na|n\/a|null|-|nil)$/i.test(s) ? null : s;
};
/** "13-09-2021" (theirs), "2021-09-13", "13/09/2021", "13-Sep-2021" -> "2021-09-13". */
function date(v) {
  const s = val(v);
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return require('../ulip/vahan').parseDate(s);
}
const number = (v) => { const s = val(v); const n = Number(String(s ?? '').replace(/,/g, '')); return s != null && Number.isFinite(n) ? n : null; };
const int = (v) => { const n = number(v); return n == null ? null : Math.round(n); };
const NOT_FOUND = /not\s*found|no\s*record|invalid\s*(vehicle|reg|registration)|does\s*not\s*exist|no\s*data/i;

/** IDSPay's answer, as { outcome, data, code, message }. */
function read(http, json, regNo) {
  const code = Number(json?.status?.code ?? json?.status_code ?? http);
  const message = String(json?.status?.message || json?.message || '').slice(0, 200);
  const d = json?.data;
  if (code !== 200 || !d || typeof d !== 'object') {
    if (NOT_FOUND.test(message)) return { outcome: 'NOT_FOUND', code: String(code), message };
    return { outcome: 'RETRY', code: String(code || http), message: message || `HTTP ${http}` };
  }
  const data = {
    reg_no: val(d.reg_no) || regNo,
    status: val(d.status),
    status_as_on: date(d.status_as_on),
    state_code: val(d.rto_code)?.slice(0, 2) || null,
    rto_code: val(d.rto_code),
    registered_at: val(d.reg_authority)?.replace(/\s+/g, ' ') || null,
    reg_date: date(d.reg_date),
    reg_upto: date(d.rc_expiry_date),
    purchase_date: null,
    manufactured: val(d.vehicle_manufacturing_month_year),
    maker: val(d.vehicle_manufacturer_name),
    model: val(d.model),
    vehicle_class: val(d.class),
    vehicle_category: val(d.vehicle_category),
    body_type: val(d.body_type),
    fuel: val(d.type),
    colour: val(d.vehicle_colour),
    norms: val(d.norms_type),
    cubic_capacity: number(d.vehicle_cubic_capacity),
    cylinders: int(d.vehicle_cylinders_no),
    seats: int(d.vehicle_seat_capacity),
    wheelbase: int(d.wheelbase),
    unladen_weight: int(d.unladen_weight),
    gross_weight: int(d.gross_vehicle_weight),
    sale_amount: null,
    // Masked here, to ULIP's level — IDSPay sends these in full.
    owner_name: maskName(val(d.owner_name)),
    owner_serial: int(d.owner_count),
    owner_type: null,
    owner_category: null,
    address: maskAddress([d.split_present_address?.pincode, d.present_address].filter(Boolean).join(' ')),
    chassis: maskTail(val(d.chassis)),
    engine: maskTail(val(d.engine)),
    financer: val(d.rc_financer),
    blacklist_status: val(d.blacklist_status),
    noc_details: val(d.noc_details),
    noc_date: null,
    insurance_company: val(d.vehicle_insurance_company_name),
    insurance_policy: val(d.vehicle_insurance_policy_number),
    insurance_upto: date(d.vehicle_insurance_upto),
    pucc_number: val(d.pucc_number),
    pucc_upto: date(d.pucc_upto),
    // IDSPay has no separate fitness date; for a private vehicle it is the RC's own validity.
    fitness_upto: date(d.rc_expiry_date),
    tax_upto: date(d.vehicle_tax_upto),
    permit_number: val(d.permit_number) || val(d.national_permit_number),
    permit_upto: date(d.permit_valid_upto) || date(d.national_permit_upto),
    permit_type: val(d.permit_type),
  };
  if (!require('../ulip/vahan').usable(data)) {
    // Keys only, never values: enough to fix the mapping, nothing personal.
    console.error('[rc-backup] answer not understood for %s; keys: %s', regNo, Object.keys(d).join(','));
    return { outcome: 'RETRY', code: 'UNREADABLE', message: 'backup answer could not be read' };
  }
  return { outcome: 'FOUND', data };
}

/**
 * Ask the backup. Returns null when it may not be used (off, not configured,
 * day's limit reached), else { outcome, data, code, message, ms }.
 */
/*
 * THE CUT-OUT (user, 2026-10-03). When the backup itself is failing, every
 * call is ₹3 for nothing. After rc_backup_pause_after (5) failures in a row —
 * across at least 3 different vehicles, so a few mistyped numbers cannot trip
 * it — it pauses for rc_backup_pause_minutes (30) and the admin is told. A
 * "not found" is an answer, not a failure. The pause survives a restart.
 */
let failRun = [];
async function pausedUntil() {
  const v = await settings.get('rc_backup_paused_until', '');
  const t = v ? new Date(v) : null;
  return t && t > new Date() ? t : null;
}
async function noteResult(regNo, failed) {
  if (!failed) {
    if (failRun.length >= 1) failRun = [];
    return;
  }
  failRun.push(regNo);
  const after = await settings.num('rc_backup_pause_after', 5);
  if (failRun.length < after || new Set(failRun).size < 3) return;
  const minutes = await settings.num('rc_backup_pause_minutes', 30);
  const until = new Date(Date.now() + minutes * 60000);
  failRun = [];
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ('rc_backup_paused_until', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [until.toISOString()]);
  settings.refresh();
  console.warn('[rc-backup] %d failures in a row — paused until %s', after, until.toISOString());
  await require('../util/adminPing').ping({
    key: 'rc_backup_paused', severity: 'warning', source: 'vehicle_api',
    title: '⏸ RC backup paused',
    text: `The paid RC backup failed ${after} times in a row, so it is paused for ${minutes} minutes to stop paying ₹3 for failures. `
      + 'Customers are saved to the waiting list meanwhile. It switches back on by itself.',
  });
}

async function lookup(regNo) {
  if (!await enabled()) return null;
  if (await pausedUntil()) return null;
  const t = await today();
  if (!t.left) {
    console.warn('[rc-backup] daily limit of %d reached — not used for %s', t.limit, regNo);
    return null;
  }
  await db.query(`INSERT INTO event_log (kind, detail) VALUES ('rc_backup_call', $1)`, [JSON.stringify({ reg_no: regNo })]);
  const t0 = Date.now();
  let out;
  try {
    const { http, json } = await request(regNo);
    out = read(http, json, regNo);
  } catch (e) {
    out = { outcome: 'RETRY', code: e.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', message: e.message + (e.cause ? ` (${e.cause.code || e.cause.message})` : '') };
  }
  out.ms = Date.now() - t0;
  status.record('rc_backup', { ok: out.outcome !== 'RETRY', ms: out.ms, error: out.outcome === 'RETRY' ? `${out.code}: ${out.message}` : null });
  await noteResult(regNo, out.outcome === 'RETRY').catch(() => {});
  return out;
}

/**
 * THE BACKUP ONLY FOR PAYING CUSTOMERS (user, 2026-10-05; setting
 * rc_backup_paid_only, default on). A free check never uses the paid backup:
 * at ~7 payers in 100, the ₹3 a free check cost while ULIP was down lost money
 * on every sale. The callers that serve free checks ask this and pass
 * backup=0; a paid report's lookup does not, so it still uses the backup.
 */
async function paidOnly() {
  return settings.bool('rc_backup_paid_only', true);
}

/** gateway options for a FREE lookup: ULIP only when the backup is for paying customers. */
async function freeOpts(extra = {}) {
  return (await paidOnly()) ? { ...extra, backup: 0 } : extra;
}

module.exports = { lookup, enabled, configured, today, pausedUntil, paidOnly, freeOpts, PATH, _test: { maskName, maskTail, maskAddress, read } };
