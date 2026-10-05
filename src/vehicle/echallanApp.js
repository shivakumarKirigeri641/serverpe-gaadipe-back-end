/**
 * src/vehicle/echallanApp.js — eChallan.app (Vahanfin Solutions), the FREE
 * second source (user, 2026-10-05: "1st priority ULIP (free), 2nd eChallan.app
 * (free), 3rd the costing IDSPay").
 *
 *   RC       ULIP VAHAN  ->  eChallan.app  ->  IDSPay (₹3, vehicle/rcBackup.js)
 *   challans ULIP e-Challan  ->  eChallan.app
 *
 * THE API (from the user, 2026-10-05) — header X-API-KEY (ECHALLANAPP_APIKEY):
 *   GET /vahanfin/vehicle?rc_no=…&refresh=true          the RC
 *   GET /vahanfin/echallan?rc_no=…&refresh=…&dispose=…  challans
 *   GET /api-credentials                                 key, credits, limits
 * Every answer carries _billing { cost, remaining_credits }. A lookup their
 * own source cannot answer comes back as provider_unavailable /
 * verification_pending — that is "go to the next source", at once, and costs
 * no credit. They very likely read the same Government VAHAN as ULIP, so the
 * value is their STORED copies and a free try before paying IDSPay.
 *
 * Their RC fields are VAHAN's own names (rc_regn_no, rc_owner_name…), so the
 * answer is read with ULIP's own reader (ulip/vahan mapJson); their challan
 * rows carry ULIP's challan fields, read with ulip/echallan mapChallan.
 *
 * PERSONAL DATA follows the RC backup's rule: kept whole in the cache when
 * rc_backup_store_full is on (marked pii_full), masked for every customer.
 *
 * Settings: echallan_app_enabled (true), echallan_app_timeout_ms (8000),
 * echallan_app_credits (last seen), echallan_app_low_credits (500 → a ping).
 */

const db = require('../db');
const settings = require('../util/settings');
const status = require('../util/providerStatus');

const BASE = () => (process.env.ECHALLANAPP_URL || 'https://api.echallan.app').replace(/\/+$/, '');
const KEY = () => process.env.ECHALLANAPP_APIKEY || process.env.ECHALLANAPP_API_KEY || '';

const configured = () => Boolean(KEY());
async function enabled() {
  return configured() && settings.bool('echallan_app_enabled', true);
}

async function get(path) {
  const t0 = Date.now();
  const res = await fetch(`${BASE()}${path}`, {
    headers: { 'X-API-KEY': KEY(), Accept: 'application/json' },
    signal: AbortSignal.timeout(await settings.num('echallan_app_timeout_ms', 8000)),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 200) }; }
  return { http: res.status, json, ms: Date.now() - t0 };
}

/** Credits left, from any answer's _billing; a ping when they run low. */
async function noteCredits(json) {
  const left = Number(json?._billing?.remaining_credits);
  if (!Number.isFinite(left)) return;
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ('echallan_app_credits', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [String(left)]).catch(() => {});
  if (left <= await settings.num('echallan_app_low_credits', 500)) {
    require('../util/adminPing').ping({
      key: 'echallan_app_credits', severity: 'warning', source: 'vehicle_api',
      title: '🎟 eChallan.app credits running low',
      text: `${left} free RC credits left at eChallan.app. When they run out, lookups go straight from ULIP to IDSPay (₹3).`,
    }).catch(() => {});
  }
}

const NOT_FOUND = /not\s*found|no\s*record|invalid\s*(vehicle|reg|rc)|does\s*not\s*exist/i;
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Their answer, as { outcome: FOUND | NOT_FOUND | RETRY, data?, code, message }. */
function readRc(http, json, regNo, { storeFull = false } = {}) {
  const message = String(json?.message || json?.error || '').slice(0, 200);
  if (http >= 500 || http === 0) return { outcome: 'RETRY', code: `HTTP${http}`, message: message || `HTTP ${http}` };
  if (http === 401 || http === 403) return { outcome: 'RETRY', code: `HTTP${http}`, message: message || 'key refused' };
  if (http === 404 && NOT_FOUND.test(message)) return { outcome: 'NOT_FOUND', code: 'HTTP404', message };
  if (json?.provider_unavailable || json?.verification_pending || /PENDING/i.test(String(json?.rc_status || ''))) {
    return { outcome: 'RETRY', code: 'UNAVAILABLE', message: message || 'their records source is unavailable' };
  }
  const body = json?.data && typeof json.data === 'object' ? json.data
    : json?.result && typeof json.result === 'object' ? json.result : json;
  // VAHAN's own snake_case names -> the camelCase ULIP's reader takes.
  const c = {};
  for (const [k, v] of Object.entries(body || {})) if (typeof v !== 'object' || v === null) c[camel(k)] = v;
  const vahan = require('../ulip/vahan');
  const data = vahan.mapJson(regNo, c);
  if (!vahan.usable(data)) {
    if (NOT_FOUND.test(message)) return { outcome: 'NOT_FOUND', code: 'NOREC', message };
    console.error('[echallan-app] RC answer not understood for %s; keys: %s', regNo, Object.keys(body || {}).join(','));
    return { outcome: 'RETRY', code: 'UNREADABLE', message: 'answer could not be read' };
  }
  // Their personal fields follow the RC backup's rule (vehicle/rcBackup.js).
  const masked = (v) => /\*/.test(String(v || ''));
  const anyFull = ['owner_name', 'chassis', 'engine'].some((k) => data[k] && !masked(data[k]));
  if (anyFull && storeFull) data.pii_full = true;
  else if (anyFull) {
    const { maskName, maskTail, maskAddress } = require('./rcBackup')._test;
    data.owner_name = maskName(data.owner_name);
    data.chassis = maskTail(data.chassis);
    data.engine = maskTail(data.engine);
    data.address = maskAddress(data.address);
  }
  return { outcome: 'FOUND', data };
}

/** The RC from eChallan.app, or null when switched off / not configured. */
async function rc(regNo) {
  if (!await enabled()) return null;
  let out;
  try {
    const r = await get(`/vahanfin/vehicle?rc_no=${encodeURIComponent(regNo.toLowerCase())}&refresh=true`);
    out = { ...readRc(r.http, r.json, regNo, { storeFull: await settings.bool('rc_backup_store_full', true) }), ms: r.ms };
    await noteCredits(r.json).catch(() => {});
  } catch (e) {
    out = { outcome: 'RETRY', code: e.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', message: e.message, ms: 0 };
  }
  status.record('echallan_app', { ok: out.outcome !== 'RETRY' || out.code === 'UNAVAILABLE', ms: out.ms,
    error: out.outcome === 'RETRY' ? `${out.code}: ${out.message}` : null });
  if (out.outcome !== 'FOUND') console.warn('[echallan-app] RC %s: %s %s — %s', regNo, out.outcome, out.code, out.message);
  return out;
}

/**
 * Challans from eChallan.app, in the shape ulip/echallan.js returns:
 * { ok, data: { pending, disposed, …, summary } } or { ok: false }.
 */
async function challans(regNo) {
  if (!await enabled()) return null;
  try {
    const r = await get(`/vahanfin/echallan?rc_no=${encodeURIComponent(regNo)}&refresh=true&dispose=true`);
    await noteCredits(r.json).catch(() => {});
    if (r.http >= 400 || !Array.isArray(r.json?.challans)) {
      if (r.json?.provider_unavailable) return { ok: false, code: 'UNAVAILABLE', ms: r.ms };
      return { ok: false, code: `HTTP${r.http}`, error: String(r.json?.message || '').slice(0, 200), ms: r.ms };
    }
    const { mapChallan, summarise } = require('../ulip/echallan');
    // Only ULIP's challan fields (read by mapChallan) and a few worth keeping;
    // their ids, pricing rules and raw provider dumps (which may hold names)
    // never enter GaadiPe.
    const ULIP_FIELDS = new Set(['challan_no', 'challan_date_time', 'challan_date', 'fine_imposed', 'amount', 'amount_of_fine_imposed',
      'challan_status', 'status', 'offence_details', 'offence', 'challan_place', 'department', 'state_code', 'rto_distric_name',
      'remark', 'document_impounded', 'dl_no', 'court_name', 'court_address', 'date_of_proceeding', 'sent_to_court_on',
      'sent_to_reg_court', 'sent_to_virtual_court', 'receipt_no', 'received_amount', 'name_of_violator', 'owner_name', 'driver_name']);
    const KEEP = new Set(['challan_type', 'challan_sub_type', 'government_payable', 'display_total', 'payment_available', 'is_offline_payable', 'last_refreshed_at']);
    const rows = r.json.challans.map((x) => {
      const merged = { ...(x.challan_data || {}), ...x };       // top-level wins; ULIP's fields either way
      const row = {};
      for (const [k, v] of Object.entries(merged)) if (ULIP_FIELDS.has(k) || KEEP.has(k)) row[k] = v;
      return row;
    });
    const isPending = (row) => /pending|unpaid|open/i.test(String(row.challan_status || row.status || 'pending'));
    const byDate = (a, b) => String(b.challan_date || '').localeCompare(String(a.challan_date || ''));
    const pending = rows.filter(isPending).map((x) => mapChallan(x, 'pending')).sort(byDate);
    const disposed = rows.filter((x) => !isPending(x)).map((x) => mapChallan(x, 'disposed')).sort(byDate);
    const sum = (list) => list.reduce((t, c) => t + (c.amount_paise || 0), 0);
    status.record('echallan_app', { ok: true, ms: r.ms });
    return {
      ok: true, ms: r.ms,
      data: {
        pending, disposed, pending_count: pending.length, disposed_count: disposed.length,
        pending_amount_paise: sum(pending), disposed_amount_paise: sum(disposed),
        summary: summarise(pending, disposed), checked_at: new Date().toISOString(), source: 'ECHALLANAPP',
      },
    };
  } catch (e) {
    status.record('echallan_app', { ok: false, ms: 0, error: e.message });
    return { ok: false, code: e.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', error: e.message };
  }
}

/** Key status, credits and limits (admin panel). */
async function account() {
  if (!configured()) return { configured: false };
  try {
    const r = await get('/api-credentials');
    const j = r.json || {};
    return {
      configured: true, enabled: await enabled(),
      status: j.credentials?.status || null, environment: j.credentials?.environment || null,
      api_credits: j.userInfo?.api_credits ?? null, credits: j.userInfo?.credits ?? null,
      used: j.rateLimits?.usedRequests ?? null, limit: j.rateLimits?.currentLimit ?? null,
      ip_restricted: Boolean(j.security?.ipRestrictionsEnabled), webhooks: Boolean(j.security?.webhooksEnabled),
    };
  } catch (e) {
    return { configured: true, error: e.message };
  }
}

module.exports = { enabled, configured, rc, challans, account, _test: { readRc } };
