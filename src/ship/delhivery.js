/**
 * src/ship/delhivery.js — DELHIVERY B2C, BY API (user, 2026-10-29: "I need to call the API, not manual booking"). Used
 * for GaadiPe Tag stickers (src/tags/orders.js): is a pincode served (and remote = ODA), create the shipment from the
 * pickup location, its label PDF, a pickup request, and tracking.
 *
 *   .env  DELHIVERY_APITOKEN (or DELHIVERY_TOKEN)   the API token from Delhivery One → Settings → API and MCP Setup
 *         DELHIVERY_MODE = staging | live           staging-express.delhivery.com (test) or track.delhivery.com
 *         DELHIVERY_PICKUP                          the pickup location (warehouse) name, default SERVERPE-BLR-560013
 * Never throws: every call returns { ok, … } or { ok: false, error }. Not configured → { ok: false, error: 'not_configured' }.
 */
const TOKEN = () => process.env.DELHIVERY_APITOKEN || process.env.DELHIVERY_TOKEN || '';
const MODE = () => (String(process.env.DELHIVERY_MODE || 'staging').toLowerCase() === 'live' ? 'live' : 'staging');
const BASE = () => (MODE() === 'live' ? 'https://track.delhivery.com' : 'https://staging-express.delhivery.com');
const PICKUP = () => process.env.DELHIVERY_PICKUP || 'SERVERPE-BLR-560013';
const configured = () => Boolean(TOKEN());

async function call(path, { method = 'GET', json = null, form = null, timeout = 20000 } = {}) {
  if (!configured()) return { ok: false, error: 'not_configured' };
  const t0 = Date.now();
  try {
    const headers = { Authorization: `Token ${TOKEN()}`, Accept: 'application/json' };
    let body;
    if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(`${BASE()}${path}`, { method, headers, body, signal: AbortSignal.timeout(timeout) });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    require('../util/providerStatus').record('delhivery', { ok: res.ok, ms: Date.now() - t0, error: res.ok ? null : `HTTP ${res.status}` });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${String(text).slice(0, 200)}`, data };
    return { ok: true, data };
  } catch (e) {
    require('../util/providerStatus').record('delhivery', { ok: false, ms: Date.now() - t0, error: e.message });
    return { ok: false, error: e.message };
  }
}

/** Is this pincode served for prepaid? { ok, served, oda, city, state, district } — oda = Out of Delivery Area (remote). */
async function serviceable(pin) {
  const out = await call(`/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(String(pin))}`);
  if (!out.ok) return out;
  const pc = out.data?.delivery_codes?.[0]?.postal_code;
  if (!pc) return { ok: true, served: false };
  return { ok: true, served: pc.pre_paid === 'Y', oda: pc.is_oda === 'Y', city: pc.city || pc.district || null,
    district: pc.district || null, state: pc.state_code || null, pickup: pc.pickup === 'Y' };
}

/** What Delhivery charges you, 560013 → pin, prepaid surface. { ok, amount (₹, incl. GST), raw } */
async function cost(toPin, { fromPin = '560013', grams = 500 } = {}) {
  const q = new URLSearchParams({ md: 'S', ss: 'Delivered', d_pin: String(toPin), o_pin: String(fromPin), cgm: String(grams), pt: 'Pre-paid' });
  const out = await call(`/api/kinko/v1/invoice/charges/.json?${q}`);
  if (!out.ok) return out;
  const row = Array.isArray(out.data) ? out.data[0] : out.data;
  return { ok: true, amount: row?.total_amount != null ? Number(row.total_amount) : null, raw: row };
}

/**
 * Create one prepaid shipment from the pickup location. { ok, waybill, raw } — Delhivery gives the waybill (AWB).
 * s: { order, name, address, pin, city, state, phone, amount, qty, desc, grams }
 */
async function createShipment(s) {
  const shipment = {
    name: String(s.name || 'Customer').slice(0, 60),
    add: String(s.address || '').replace(/\s+/g, ' ').slice(0, 300),
    pin: String(s.pin), city: s.city || '', state: s.state || '', country: 'India',
    phone: String(s.phone || '').replace(/\D/g, '').slice(-10),
    order: String(s.order), payment_mode: 'Prepaid',
    products_desc: s.desc || 'GaadiPe Tag stickers', hsn_code: '', cod_amount: '0',
    total_amount: String(s.amount || 0), quantity: String(s.qty || 1),
    weight: String(s.grams || 50), shipment_length: '24', shipment_width: '16', shipment_height: '1',
    shipping_mode: 'Surface', seller_name: 'ServerPe App Solutions', seller_add: '', seller_inv: String(s.order),
  };
  const out = await call('/api/cmu/create.json', { method: 'POST',
    form: { format: 'json', data: JSON.stringify({ shipments: [shipment], pickup_location: { name: PICKUP() } }) } });
  if (!out.ok) return out;
  const pkg = out.data?.packages?.[0];
  if (!pkg?.waybill || String(pkg.status || '').toLowerCase() === 'fail') {
    const why = [...(pkg?.remarks || []), out.data?.rmk].filter(Boolean).join('; ') || 'shipment not created';
    return { ok: false, error: why, raw: out.data };
  }
  return { ok: true, waybill: String(pkg.waybill), raw: out.data };
}

/** The shipping label (PDF link) for a waybill. { ok, url } */
async function label(waybill) {
  const out = await call(`/api/p/packing_slip?wbns=${encodeURIComponent(waybill)}&pdf=true`);
  if (!out.ok) return out;
  const p = out.data?.packages?.[0] || {};
  const url = p.pdf_download_link || p.pdf_link || null;
  return url ? { ok: true, url } : { ok: false, error: 'no label link in the response', raw: out.data };
}

/** Ask for a pickup at the pickup location. { ok, id } */
async function pickup({ date, time = '14:00:00', count = 1 }) {
  const out = await call('/fm/request/new/', { method: 'POST',
    json: { pickup_time: time, pickup_date: date, pickup_location: PICKUP(), expected_package_count: Math.max(1, Number(count) || 1) } });
  if (!out.ok) return out;
  const id = out.data?.pickup_id || out.data?.data?.pickup_id || null;
  return { ok: true, id, raw: out.data };
}

/** Where it is now. { ok, status, at, location } */
async function track(waybill) {
  const out = await call(`/api/v1/packages/json/?waybill=${encodeURIComponent(waybill)}`);
  if (!out.ok) return out;
  const st = out.data?.ShipmentData?.[0]?.Shipment?.Status || {};
  // Delhivery's times are India time with no zone ("2026-10-29T10:15:00.123"); places read like "Bengaluru_Hub".
  const at = st.StatusDateTime && !/(Z|[+-]\d\d:?\d\d)$/.test(st.StatusDateTime) ? `${st.StatusDateTime}+05:30` : (st.StatusDateTime || null);
  return { ok: true, status: st.Status || null, at, location: st.StatusLocation ? String(st.StatusLocation).replace(/_/g, ' ') : null,
    instructions: st.Instructions || null };
}

module.exports = { configured, mode: MODE, pickupName: PICKUP, serviceable, cost, createShipment, label, pickup, track };
