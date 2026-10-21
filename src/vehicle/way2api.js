/**
 * src/vehicle/way2api.js — the cheaper paid RC source, asked before IDSPay (user, 2026-10-21:
 * "Way2API first, IDSPay as the backup"). Tested on three vehicles: the same insurance, tax, fitness,
 * loan, owner count and PUC as IDSPay, fetched live.
 *
 *   ULIP VAHAN answers          -> nothing spent
 *   eChallan.app answers        -> nothing spent
 *   Way2API answers             -> $0.0254 a call with GST (≈ ₹2.40; way2api_cost_paise)
 *   Way2API fails / not usable  -> IDSPay, as before (vehicle/rcBackup.js)
 *
 * THE PROVIDER: POST https://app.way2api.com/api/v1/rc/verify, body { rc_number }, the key from
 *   WAYTWOAPI_KEY in .env — sent as "Authorization: Bearer <key>", or in the header named by
 *   WAYTWOAPI_AUTH_HEADER (e.g. x-api-key) if Way2API wants it there. Success: success = true and
 *   data.result holds the vehicle. Their answer is NOT masked.
 *
 * GUARDS (Settings → IDSPay / Way2API)
 *   way2api_enabled            true; false sends every paid lookup straight to IDSPay
 *   way2api_daily_limit        calls per IST day (300); past it, IDSPay is asked
 *   way2api_balance_usd        the wallet in dollars — UPDATE AFTER EVERY RECHARGE; each charged call
 *                              takes way2api_cost_usd (0.0254) off. Blank = not tracked. Below one
 *                              call's price it is skipped (IDSPay answers) and the admin is emailed
 *   way2api_low_balance_usd    1.00 — at or below it, one email a day
 *
 * The paid-only rule (rc_backup_paid_only) and IDSPay-once-per-vehicle (rcBackup.freeOpts) cover it
 * too: callers that pass backup=0 skip both paid sources.
 *
 * PRIVACY: kept whole in the database (rc_backup_store_full, as IDSPay) and masked wherever it is
 * shown; off, masked here to ULIP's level. Their PDF link (text-pdf, a third party's server) is never
 * asked for.
 */

const db = require('../db');
const settings = require('../util/settings');
const status = require('../util/providerStatus');
const U = require('./rcBackup').util;

const PATH = 'WAY2API';
const URL_ = () => String(process.env.WAYTWOAPI_URL || 'https://app.way2api.com/api/v1/rc/verify').trim();
const KEY = () => String(process.env.WAYTWOAPI_KEY || '').trim();
const configured = () => Boolean(KEY());

async function enabled() {
  return configured() && settings.bool('way2api_enabled', true);
}

/** Calls made today (IST), and whether another is allowed. */
async function today() {
  const row = await db.one(
    `SELECT count(*)::int AS n FROM event_log
      WHERE kind = 'way2api_call'
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`);
  const limit = await settings.num('way2api_daily_limit', 300);
  return { used: row?.n || 0, limit, left: Math.max(0, limit - (row?.n || 0)) };
}

async function request(regNo) {
  const header = String(process.env.WAYTWOAPI_AUTH_HEADER || '').trim();
  const auth = header ? { [header]: KEY() } : { Authorization: `Bearer ${KEY()}` };
  const res = await fetch(URL_(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...auth },
    body: JSON.stringify({ rc_number: regNo }),
    signal: AbortSignal.timeout(Number(process.env.WAYTWOAPI_TIMEOUT_MS) || 25000),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 200) }; }
  return { http: res.status, json };
}

/** Way2API's answer, as { outcome, data, code, message, charged }. */
function read(http, json, regNo, { storeFull = false } = {}) {
  const { val, date, number, int, maskName, maskTail, maskAddress, NOT_FOUND } = U;
  const ok = json?.success === true || /^success$/i.test(String(json?.status || ''));
  const code = String(json?.message_code || json?.status_code || http);
  const message = String(json?.message || json?.data?.message || '').slice(0, 200);
  const charged = json?.charged !== false;
  const d = json?.data?.result;
  if (!ok || !d || typeof d !== 'object') {
    if (NOT_FOUND.test(message) || NOT_FOUND.test(code)) return { outcome: 'NOT_FOUND', code, message, charged };
    return { outcome: 'RETRY', code, message: message || `HTTP ${http}`, charged: json?.charged === true };
  }
  const full = storeFull;
  const keep = (v, mask) => (full ? v : mask(v));
  const data = {
    ...(full ? { pii_full: true } : {}),
    reg_no: val(d.rc_number)?.toUpperCase() || regNo,
    status: val(d.rc_status),
    status_as_on: date(d.latest_by),
    state_code: val(d.rto_code)?.slice(0, 2) || null,
    rto_code: val(d.rto_code),
    registered_at: val(d.registered_at)?.replace(/\s+/g, ' ') || null,
    reg_date: date(d.registration_date),
    reg_upto: date(d.fit_up_to),
    purchase_date: null,
    manufactured: val(d.manufacturing_date),
    maker: val(d.maker_description),
    model: val(d.maker_model),
    vehicle_class: val(d.vehicle_category_description),
    vehicle_category: val(d.vehicle_category),
    body_type: val(d.body_type),
    fuel: val(d.fuel_type),
    colour: val(d.color),
    norms: val(d.norms_type),
    cubic_capacity: number(d.cubic_capacity),
    cylinders: int(d.no_cylinders),
    seats: int(d.seat_capacity),
    wheelbase: int(d.wheelbase),
    unladen_weight: int(d.unladen_weight),
    gross_weight: int(d.vehicle_gross_weight),
    sale_amount: null,
    owner_name: keep(val(d.owner_name)?.replace(/\s+/g, ' '), maskName),
    owner_serial: int(d.owner_number),
    owner_type: null,
    owner_category: null,
    address: full ? (val(d.present_address)?.replace(/\s+/g, ' ').replace(/(,\s*)+/g, ', ') || null) : maskAddress(d.present_address),
    chassis: keep(val(d.vehicle_chasi_number), maskTail),
    engine: keep(val(d.vehicle_engine_number), maskTail),
    financer: val(d.financer),
    blacklist_status: val(d.blacklist_status),
    noc_details: val(d.noc_details),
    noc_date: null,
    insurance_company: val(d.insurance_company),
    insurance_policy: val(d.insurance_policy_number),
    insurance_upto: date(d.insurance_upto),
    pucc_number: val(d.pucc_number),
    pucc_upto: date(d.pucc_upto),
    fitness_upto: date(d.fit_up_to),
    tax_upto: date(d.tax_upto) || date(d.tax_paid_upto),
    permit_number: val(d.permit_number) || val(d.national_permit_number),
    permit_upto: date(d.permit_valid_upto) || date(d.national_permit_upto),
    permit_type: val(d.permit_type),
  };
  if (!require('../ulip/vahan').usable(data)) {
    console.error('[way2api] answer not understood for %s; keys: %s', regNo, Object.keys(d).join(','));
    return { outcome: 'RETRY', code: 'UNREADABLE', message: 'Way2API answer could not be read', charged };
  }
  require('../ulip/vahan').fillFromReg(data, regNo);
  require('../ulip/vahan').noteGaps('Way2API', regNo, data);
  return { outcome: 'FOUND', data, charged };
}

/* ─────────────────────────── the wallet, in dollars ─────────────────────────── */

const usd = (n) => `$${Number(n).toFixed(4).replace(/(\.\d\d)\d*?0+$/, '$1')}`;

/** The tracked balance in dollars, or null when not tracked (blank). */
async function balance() {
  const raw = String(await settings.get('way2api_balance_usd', '') ?? '').trim();
  return raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw);
}

/** One charged call off the wallet; one email a day while it is low. Returns the new balance or null. */
async function noteCall(charged) {
  const before = await balance();
  if (before === null) return null;
  const cost = await settings.num('way2api_cost_usd', 0.0254);
  const after = charged ? Math.max(0, Math.round((before - cost) * 10000) / 10000) : before;
  if (after !== before) await U.setSetting('way2api_balance_usd', after);
  const low = await settings.num('way2api_low_balance_usd', 1);
  if (after <= low) {
    const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const first = await db.one(
      `INSERT INTO event_log (kind, detail) SELECT 'way2api_low_mail', $1::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM event_log WHERE kind = 'way2api_low_mail' AND detail->>'day' = $2) RETURNING id`,
      [JSON.stringify({ day, balance_usd: after }), day]).catch(() => null);
    if (first) require('../util/adminPing').ping({
      key: `way2api_low_balance:${day}`, severity: 'warning', source: 'vehicle_api',
      title: `💰 Way2API balance low — ${usd(after)} left`,
      text: `The Way2API wallet is about ${usd(after)} (${usd(low)} or less). When it cannot pay for a call, lookups go to IDSPay `
        + `instead (₹2.95). Recharge Way2API and enter the new balance in Settings → way2api_balance_usd.`,
    }).catch(() => {});
  }
  return after;
}

/**
 * Ask Way2API. Returns null when it may not be used (off, not configured, day's limit reached, wallet
 * empty), else { outcome, data, code, message, ms }.
 */
async function lookup(regNo) {
  if (!await enabled()) return null;
  const t = await today();
  if (!t.left) {
    console.warn('[way2api] daily limit of %d reached — IDSPay asked for %s', t.limit, regNo);
    return null;
  }
  const bal = await balance();
  if (bal !== null && bal < await settings.num('way2api_cost_usd', 0.0254)) {
    console.warn('[way2api] wallet %s — too low for a call, IDSPay asked for %s', usd(bal), regNo);
    await noteCall(false).catch(() => {});
    return null;
  }
  await db.query(`INSERT INTO event_log (kind, detail) VALUES ('way2api_call', $1)`, [JSON.stringify({ reg_no: regNo })]);
  const t0 = Date.now();
  let out;
  try {
    const { http, json } = await request(regNo);
    out = read(http, json, regNo, { storeFull: await settings.bool('rc_backup_store_full', true) });
    const left = await noteCall(out.charged).catch((e) => { console.error('[way2api] balance:', e.message); return null; });
    console.log('[way2api] %s: %s · call %d/%d today · balance %s', regNo, out.outcome, t.used + 1, t.limit,
      left === null ? 'not tracked — enter it in Settings → way2api_balance_usd' : usd(left));
  } catch (e) {
    out = { outcome: 'RETRY', code: e.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', message: e.message + (e.cause ? ` (${e.cause.code || e.cause.message})` : '') };
  }
  out.ms = Date.now() - t0;
  if (out.outcome !== 'FOUND') {
    console.warn('[way2api] %s: %s %s — %s (%d ms)', regNo, out.outcome, out.code || '', out.message || '', out.ms);
    // Money or keys: only the admin can fix those.
    if (/balance|insufficient|recharge|credit|wallet|unauthori[sz]ed|forbidden|invalid\s*(api|token|key)|expired|suspend|401|403/i.test(`${out.code} ${out.message}`)) {
      require('../util/adminPing').ping({
        key: 'way2api_account', severity: 'critical', source: 'vehicle_api',
        title: '💳 Way2API refused the call',
        text: `Way2API said: "${String(out.message).slice(0, 160)}" (code ${out.code}). Lookups go to IDSPay meanwhile. `
          + 'Check the Way2API wallet and key (WAYTWOAPI_KEY).',
      }).catch(() => {});
    }
  }
  status.record('way2api', { ok: out.outcome !== 'RETRY', ms: out.ms, error: out.outcome === 'RETRY' ? `${out.code}: ${out.message}` : null });
  return out;
}

module.exports = { lookup, enabled, configured, today, balance, PATH, _test: { read } };
