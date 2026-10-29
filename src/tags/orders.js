/**
 * src/tags/orders.js — THE DELIVERED STICKER (user, 2026-10-29: "digital + paid; paid depends on distance / courier
 * charges"). The owner sends their pincode, sees the charge for its zone (Settings tag_zone_*: Bengaluru ₹59, rest of
 * the state ₹69, rest of India ₹79, remote ₹119 — GST and delivery included), then their name and address, and pays on
 * GaadiPe's own checkout page (/pay/<token>) like a check pack — test mode for the owner's own number. Paid, the admin
 * posts it from the Tags page and types the courier and tracking number; the owner is told.
 *
 *   quote(pin)                                     { zone, label, paise, rupees, state } or null
 *   startOrder({ user, tag, pincode, name, address }) the payments row with its checkout_token
 *   onPaid(c, pay)                                 inside billing.activate's transaction
 *   notifyPaid(result, user)                       the WhatsApp confirmation (the invoice follows from payments.js)
 *   dispatch(orderId, { courier, tracking })       admin: posted → the owner hears where it is
 *   overview()                                     admin: counts and the orders
 */
const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');
const pin = require('./pincode');
const T = require('./tags');

const ZONE_LABEL = { city: 'Bengaluru', state: 'Rest of Karnataka', india: 'Rest of India', remote: 'Remote area' };

/* THE PRICE (user, 2026-10-29; migration 220): at least tag_sticker_min (2) stickers for tag_sticker_base (₹149), each
   more tag_sticker_extra (₹49) — GST and delivery included, any vehicle; tag_remote_extra for remote pincodes (₹0). */
async function pricing() {
  return {
    min: await settings.num('tag_sticker_min', 2), base: await settings.num('tag_sticker_base', 149),
    extra: await settings.num('tag_sticker_extra', 49), max: await settings.num('tag_sticker_max', 10),
    remote: await settings.num('tag_remote_extra', 0),
  };
}
async function priceFor(qty, zone = null) {
  const p = await pricing();
  const n = Math.min(p.max, Math.max(p.min, Number(qty) || p.min));
  return { qty: n, rupees: p.base + (n - p.min) * p.extra + (zone === 'remote' ? p.remote : 0), pricing: p };
}

/* DELHIVERY'S WORD ON THE PINCODE (src/ship/delhivery.js, when its token is set): not served → no order; Out of
   Delivery Area (ODA) → the remote surcharge; its city and state go on the shipment. If Delhivery cannot be asked,
   the pincode's own digits decide, as before — an order is never refused because a lookup failed. */
async function quote(pincode, qty = 2) {
  const p = String(pincode || '').replace(/\D/g, '');
  if (!pin.valid(p)) return null;
  const pickup = String(await settings.get('tag_pickup_pincode', '560013') || '560013');
  let zone = pin.zoneOf(p, pickup);
  let city = null;
  const D = require('../ship/delhivery');
  if (D.configured()) {
    const s = await D.serviceable(p).catch(() => ({ ok: false }));
    if (s.ok && !s.served) return { pincode: p, unserviceable: true };
    if (s.ok && s.oda) zone = 'remote';
    if (s.ok) city = s.city || null;
  }
  const { qty: n, rupees } = await priceFor(qty, zone);
  const label = zone === 'city' && !pickup.startsWith('560') ? 'Same city' : ZONE_LABEL[zone];
  const days = { city: '1–2', state: '2–4', india: '3–6', remote: '5–10' }[zone];
  return { pincode: p, zone, label, qty: n, rupees, paise: Math.round(rupees * 100), state: pin.stateOf(p), city, days };
}

async function startOrder({ user, tag, pincode, name, address, qty = 2 }) {
  const razorpay = require('../pay/razorpay');
  const billing = require('../pay/billing');
  const q = await quote(pincode, qty);
  if (!q || q.unserviceable) throw new Error('bad_pincode');
  const plan = await db.one(`SELECT * FROM plans WHERE code = 'TAG_STICKER'`);
  if (!plan || !razorpay.configured()) throw new Error('payments_unavailable');
  const test = await razorpay.isTestBuyer(user).catch(() => false);

  const order = (await db.query(
    `INSERT INTO tag_orders (tag_id, user_id, pincode, zone, amount_paise, ship_name, ship_address, quantity, ship_city, ship_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [tag.id, user.id, q.pincode, q.zone, q.paise, String(name || '').slice(0, 80), String(address || '').slice(0, 400), q.qty,
      q.city, q.state ? (require('../pay/invoice').STATES[q.state] || null) : null])).rows[0];
  const pending = await billing.createPending({ userId: user.id, planId: plan.id, amountPaise: q.paise, vehicleId: tag.vehicle_id, channel: 'whatsapp' });
  const rz = await razorpay.createOrder({
    amountPaise: q.paise, receipt: `gp-${pending.id}`,
    notes: { reference_id: `gp-${pending.id}`, mobile: user.mobile, plan: 'TAG_STICKER', tag: tag.code, ...(test ? { test_mode: 'owner' } : {}) },
    test,
  });
  if (!rz?.id) throw new Error('no order id returned');
  const token = crypto.randomBytes(16).toString('hex');
  const row = (await db.query(
    `UPDATE payments SET order_id = $2, checkout_token = $3, raw = COALESCE(raw, '{}'::jsonb) || $4::jsonb
      WHERE id = $1 RETURNING *`,
    [pending.id, rz.id, token, JSON.stringify({
      order_id: rz.id, tag_order_id: order.id, tag_code: tag.code,
      sticker: { pincode: q.pincode, zone: q.zone, label: q.label, qty: q.qty },
      // The invoice's place of supply is where the sticker goes (CGST+SGST in Karnataka, IGST elsewhere).
      ...(q.state ? { buyer_state_code: q.state } : {}),
      ...(name ? { buyer_name: String(name).slice(0, 80) } : {}),
      ...(test ? { test_mode: true } : {}),
    })])).rows[0];
  await db.query(`UPDATE tag_orders SET payment_row_id = $2 WHERE id = $1`, [order.id, row.id]);
  await db.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'purchase_consent', $2)`,
    [user.id, JSON.stringify({ mobile: user.mobile, amount_paise: q.paise, plan: 'TAG_STICKER', tag: tag.code,
      documents: ['terms', 'refund', 'privacy'], payment_row: String(row.id), at: new Date().toISOString() })]).catch(() => {});
  return { payment: row, order, quote: q };
}

/** Inside billing.activate's transaction: the order is paid. */
async function onPaid(c, pay) {
  await c.query(`UPDATE tag_orders SET status = 'paid', paid_at = now() WHERE payment_row_id = $1 AND status = 'created'`, [pay.id]);
}

async function notifyPaid(result, user) {
  const send = require('../whatsapp/send');
  const o = await db.one(
    `SELECT o.*, t.code, v.reg_no FROM tag_orders o JOIN qr_tags t ON t.id = o.tag_id JOIN vehicles v ON v.id = t.vehicle_id
      WHERE o.payment_row_id = $1`, [result.payment.id]);
  if (!o) return;
  const body = `✅ *${o.quantity} stickers ordered — ${T.masked(o.reg_no)}*\n\n`
    + `We'll post your GaadiPe Tag stickers to pincode *${o.pincode}* within 2 working days, and send you the tracking number here.\n\n`
    + 'Until it arrives, your free digital tag already works — the QR you have can be printed at any shop.\n\n'
    + 'Your GST invoice follows.';
  const out = await send.buttons(user.mobile, body, [{ id: 'tag_menu', title: '🏷️ My tags' }, { id: 'menu', title: 'Menu' }]).catch(() => ({ ok: false }));
  if (!out.ok) await send.text(user.mobile, body).catch(() => {});
  require('../util/adminPing').ping({
    key: `tag_order:${o.id}`, severity: 'info', source: 'tags',
    title: `🏷️ ${o.quantity} stickers to post — ${o.reg_no} → ${o.pincode}`,
    text: `Order #${o.id} paid (${result.payment.raw?.test_mode ? 'TEST' : `₹${(o.amount_paise / 100).toFixed(0)}`}), ${o.quantity} stickers of tag ${o.code}. Ship to: ${o.ship_name || ''}, ${o.ship_address || ''} — ${o.pincode}. Post it and enter the tracking number on the admin Tags page.`,
  }).catch(() => {});
}

/** Admin: the sticker is posted. The owner hears the courier and tracking number (WhatsApp, else SMS). */
async function dispatch(orderId, { courier, tracking }) {
  const o = await db.one(
    `UPDATE tag_orders SET status = 'dispatched', dispatched_at = now(), courier = $2, tracking = $3
      WHERE id = $1 AND status IN ('paid', 'dispatched') RETURNING *`,
    [orderId, String(courier || '').trim().slice(0, 40), String(tracking || '').trim().slice(0, 40)]);
  if (!o) return { ok: false, error: 'Only a paid order can be marked as posted.' };
  const row = await db.one(
    `SELECT u.mobile, coalesce(nullif(u.display_name, ''), nullif(u.wa_profile_name, ''), 'there') AS name, v.reg_no
       FROM tag_orders o JOIN users u ON u.id = o.user_id JOIN qr_tags t ON t.id = o.tag_id JOIN vehicles v ON v.id = t.vehicle_id
      WHERE o.id = $1`, [orderId]);
  const send = require('../whatsapp/send');
  const first = String(row.name).trim().split(/\s+/)[0];
  const body = `📦 *Your GaadiPe Tag sticker is on its way* — ${T.masked(row.reg_no)}\n\nCourier: *${o.courier || '—'}*\nTracking number: *${o.tracking || '—'}*\n\n`
    + 'Once it arrives, stick it on the rear windscreen or a side window.';
  let told = await send.buttons(row.mobile, body, [{ id: 'tag_menu', title: '🏷️ My tags' }, { id: 'menu', title: 'Menu' }]).catch(() => ({ ok: false }));
  if (!told.ok) {
    told = await send.template(row.mobile, await settings.get('tag_shipped_template', 'gp_tag_shipped_v1'),
      [first, T.masked(row.reg_no), o.courier || 'Courier', o.tracking || '-'], { buttons: ['tag_menu', 'menu'] }).catch(() => ({ ok: false }));
  }
  if (!told.ok) {
    told = await require('../util/sms').sendTemplate('tag_shipped', row.mobile,
      [row.reg_no.replace(/^(.{4}).*(.{4})$/, '$1XX$2'), o.courier || 'courier', o.tracking || '-']).catch(() => ({ ok: false }));
  }
  return { ok: true, order: o, told: Boolean(told?.ok) };
}

/* ─────────────────────────────── by Delhivery's API (src/ship/delhivery.js) ─────────────────────────────── */

const istDate = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

/** Book a paid order with Delhivery: the waybill becomes the tracking number and the owner is told (as dispatch()). */
async function book(orderId) {
  const D = require('../ship/delhivery');
  if (!D.configured()) return { ok: false, error: 'Delhivery is not set up (DELHIVERY_APITOKEN in .env).' };
  const o = await db.one(
    `SELECT o.*, t.code, v.reg_no, u.mobile FROM tag_orders o JOIN qr_tags t ON t.id = o.tag_id JOIN vehicles v ON v.id = t.vehicle_id
       JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [Number(orderId) || 0]);
  if (!o) return { ok: false, error: 'No such order.' };
  if (o.status !== 'paid') return { ok: false, error: o.waybill ? `Already booked: ${o.waybill}` : 'Only a paid order can be booked.' };
  const s = await D.createShipment({
    order: `GPT-${o.id}`, name: o.ship_name, address: o.ship_address, pin: o.pincode, city: o.ship_city, state: o.ship_state,
    phone: o.mobile, amount: Math.round(o.amount_paise / 100), qty: o.quantity, desc: `GaadiPe Tag stickers x${o.quantity}`, grams: 50,
  });
  if (!s.ok) {
    await db.query(`UPDATE tag_orders SET ship_error = $2 WHERE id = $1`, [o.id, String(s.error).slice(0, 300)]);
    return { ok: false, error: `Delhivery: ${s.error}` };
  }
  await db.query(`UPDATE tag_orders SET waybill = $2, booked_at = now(), ship_error = NULL, ship_status = 'Manifested', ship_status_at = now() WHERE id = $1`,
    [o.id, s.waybill]);
  const told = await dispatch(o.id, { courier: `Delhivery${D.mode() === 'live' ? '' : ' (test)'}`, tracking: s.waybill });
  return { ok: true, waybill: s.waybill, told: told.told };
}

async function labelFor(orderId) {
  const o = await db.one(`SELECT waybill FROM tag_orders WHERE id = $1`, [Number(orderId) || 0]);
  if (!o?.waybill) return { ok: false, error: 'Book the order with Delhivery first.' };
  return require('../ship/delhivery').label(o.waybill);
}

/** One pickup for every booked parcel not yet asked for: today if before noon IST, else tomorrow, at 2 PM. */
async function requestPickup() {
  const { rows } = await db.query(`SELECT id FROM tag_orders WHERE waybill IS NOT NULL AND pickup_id IS NULL AND status = 'dispatched'`);
  if (!rows.length) return { ok: false, error: 'No booked parcels waiting for a pickup.' };
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600e3);
  const date = ist.getUTCHours() < 12 ? istDate(now) : istDate(new Date(now.getTime() + 24 * 3600e3));
  const p = await require('../ship/delhivery').pickup({ date, count: rows.length });
  if (!p.ok) return { ok: false, error: `Delhivery: ${p.error}` };
  await db.query(`UPDATE tag_orders SET pickup_id = $2 WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id), String(p.id || `requested ${date}`)]);
  return { ok: true, date, count: rows.length, id: p.id };
}

/** Where every booked parcel is now; Delivered → the order is delivered. */
async function refreshTracking() {
  const D = require('../ship/delhivery');
  const { rows } = await db.query(`SELECT id, waybill FROM tag_orders WHERE waybill IS NOT NULL AND status = 'dispatched' ORDER BY id LIMIT 50`);
  let updated = 0; let delivered = 0;
  for (const r of rows) {
    const t = await D.track(r.waybill).catch(() => ({ ok: false }));
    if (!t.ok || !t.status) continue;
    const done = /^delivered$/i.test(t.status);
    await db.query(
      `UPDATE tag_orders SET ship_status = $2, ship_status_at = coalesce($3::timestamptz, now()),
              status = CASE WHEN $4 THEN 'delivered' ELSE status END, delivered_at = CASE WHEN $4 THEN now() ELSE delivered_at END
        WHERE id = $1`, [r.id, `${t.status}${t.location ? ` · ${t.location}` : ''}`.slice(0, 120), t.at || null, done]);
    updated += 1; if (done) delivered += 1;
  }
  return { ok: true, checked: rows.length, updated, delivered };
}

async function overview() {
  const c = await db.one(
    `SELECT (SELECT count(*) FROM qr_tags WHERE is_active)::int AS tags,
            (SELECT count(DISTINCT user_id) FROM qr_tags WHERE is_active)::int AS owners,
            (SELECT coalesce(sum(scans), 0) FROM qr_tags)::int AS scans,
            (SELECT count(*) FROM tag_messages)::int AS messages,
            (SELECT count(*) FROM tag_messages WHERE created_at > now() - interval '1 day')::int AS messages_today,
            (SELECT count(*) FROM tag_messages WHERE replies > 0)::int AS answered,
            (SELECT count(*) FROM tag_blocks)::int AS blocks,
            (SELECT count(*) FROM tag_blocks WHERE reported)::int AS reports,
            (SELECT count(*) FROM tag_orders WHERE status = 'paid')::int AS to_post,
            (SELECT count(*) FROM tag_orders WHERE status = 'dispatched')::int AS posted`);
  const { rows: orders } = await db.query(
    `SELECT o.id, o.status, o.pincode, o.zone, o.quantity, o.amount_paise, o.ship_name, o.ship_address, o.courier, o.tracking,
            o.waybill, o.pickup_id, o.ship_status, o.ship_status_at, o.ship_error, o.delivered_at,
            o.created_at, o.paid_at, o.dispatched_at, t.code, v.reg_no, u.mobile, p.raw->>'test_mode' AS test
       FROM tag_orders o JOIN qr_tags t ON t.id = o.tag_id JOIN vehicles v ON v.id = t.vehicle_id JOIN users u ON u.id = o.user_id
       LEFT JOIN payments p ON p.id = o.payment_row_id
      WHERE o.status <> 'created' OR o.created_at > now() - interval '2 days'
      ORDER BY (o.status = 'paid') DESC, o.created_at DESC LIMIT 100`);
  const { rows: recent } = await db.query(
    `SELECT m.id, m.reason, m.status, m.channel, m.replies, m.created_at, t.code, v.reg_no,
            right(m.sender_mobile, 4) AS sender_last4
       FROM tag_messages m JOIN qr_tags t ON t.id = m.tag_id JOIN vehicles v ON v.id = t.vehicle_id
      ORDER BY m.id DESC LIMIT 30`);
  const D = require('../ship/delhivery');
  return { counts: c, orders, recent, enabled: await T.switchOn(),
    delhivery: { configured: D.configured(), mode: D.mode(), pickup: D.pickupName() } };
}

module.exports = { quote, priceFor, pricing, startOrder, onPaid, notifyPaid, dispatch, book, labelFor, requestPickup, refreshTracking, overview };
