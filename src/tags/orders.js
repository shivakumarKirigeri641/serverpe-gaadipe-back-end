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

async function quote(pincode) {
  const p = String(pincode || '').replace(/\D/g, '');
  if (!pin.valid(p)) return null;
  const pickup = String(await settings.get('tag_pickup_pincode', '560013') || '560013');
  const zone = pin.zoneOf(p, pickup);
  const rupees = await settings.num(`tag_zone_${zone}`, { city: 59, state: 69, india: 79, remote: 119 }[zone]);
  const label = zone === 'city' && !pickup.startsWith('560') ? 'Same city' : ZONE_LABEL[zone];
  const days = { city: '1–2', state: '2–4', india: '3–6', remote: '5–10' }[zone];
  return { pincode: p, zone, label, rupees, paise: Math.round(rupees * 100), state: pin.stateOf(p), days };
}

async function startOrder({ user, tag, pincode, name, address }) {
  const razorpay = require('../pay/razorpay');
  const billing = require('../pay/billing');
  const q = await quote(pincode);
  if (!q) throw new Error('bad_pincode');
  const plan = await db.one(`SELECT * FROM plans WHERE code = 'TAG_STICKER'`);
  if (!plan || !razorpay.configured()) throw new Error('payments_unavailable');
  const test = await razorpay.isTestBuyer(user).catch(() => false);

  const order = (await db.query(
    `INSERT INTO tag_orders (tag_id, user_id, pincode, zone, amount_paise, ship_name, ship_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [tag.id, user.id, q.pincode, q.zone, q.paise, String(name || '').slice(0, 80), String(address || '').slice(0, 400)])).rows[0];
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
      sticker: { pincode: q.pincode, zone: q.zone, label: q.label },
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
    `SELECT o.*, t.code, v.reg_no FROM tag_orders o JOIN vehicle_tags t ON t.id = o.tag_id JOIN vehicles v ON v.id = t.vehicle_id
      WHERE o.payment_row_id = $1`, [result.payment.id]);
  if (!o) return;
  const body = `✅ *Sticker ordered — ${T.masked(o.reg_no)}*\n\n`
    + `We'll post your GaadiPe Tag sticker to pincode *${o.pincode}* within 2 working days, and send you the tracking number here.\n\n`
    + 'Until it arrives, your free digital tag already works — the QR you have can be printed at any shop.\n\n'
    + 'Your GST invoice follows.';
  const out = await send.buttons(user.mobile, body, [{ id: 'tag_menu', title: '🏷️ My tags' }, { id: 'menu', title: 'Menu' }]).catch(() => ({ ok: false }));
  if (!out.ok) await send.text(user.mobile, body).catch(() => {});
  require('../util/adminPing').ping({
    key: `tag_order:${o.id}`, severity: 'info', source: 'tags',
    title: `🏷️ Sticker order to post — ${o.reg_no} → ${o.pincode}`,
    text: `Order #${o.id} paid (${result.payment.raw?.test_mode ? 'TEST' : `₹${(o.amount_paise / 100).toFixed(0)}`}). Ship to: ${o.ship_name || ''}, ${o.ship_address || ''} — ${o.pincode}. Post it and enter the tracking number on the admin Tags page.`,
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
       FROM tag_orders o JOIN users u ON u.id = o.user_id JOIN vehicle_tags t ON t.id = o.tag_id JOIN vehicles v ON v.id = t.vehicle_id
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

async function overview() {
  const c = await db.one(
    `SELECT (SELECT count(*) FROM vehicle_tags WHERE is_active)::int AS tags,
            (SELECT count(DISTINCT user_id) FROM vehicle_tags WHERE is_active)::int AS owners,
            (SELECT coalesce(sum(scans), 0) FROM vehicle_tags)::int AS scans,
            (SELECT count(*) FROM tag_messages)::int AS messages,
            (SELECT count(*) FROM tag_messages WHERE created_at > now() - interval '1 day')::int AS messages_today,
            (SELECT count(*) FROM tag_messages WHERE replies > 0)::int AS answered,
            (SELECT count(*) FROM tag_blocks)::int AS blocks,
            (SELECT count(*) FROM tag_blocks WHERE reported)::int AS reports,
            (SELECT count(*) FROM tag_orders WHERE status = 'paid')::int AS to_post,
            (SELECT count(*) FROM tag_orders WHERE status = 'dispatched')::int AS posted`);
  const { rows: orders } = await db.query(
    `SELECT o.id, o.status, o.pincode, o.zone, o.amount_paise, o.ship_name, o.ship_address, o.courier, o.tracking,
            o.created_at, o.paid_at, o.dispatched_at, t.code, v.reg_no, u.mobile, p.raw->>'test_mode' AS test
       FROM tag_orders o JOIN vehicle_tags t ON t.id = o.tag_id JOIN vehicles v ON v.id = t.vehicle_id JOIN users u ON u.id = o.user_id
       LEFT JOIN payments p ON p.id = o.payment_row_id
      WHERE o.status <> 'created' OR o.created_at > now() - interval '2 days'
      ORDER BY (o.status = 'paid') DESC, o.created_at DESC LIMIT 100`);
  const { rows: recent } = await db.query(
    `SELECT m.id, m.reason, m.status, m.channel, m.replies, m.created_at, t.code, v.reg_no,
            right(m.sender_mobile, 4) AS sender_last4
       FROM tag_messages m JOIN vehicle_tags t ON t.id = m.tag_id JOIN vehicles v ON v.id = t.vehicle_id
      ORDER BY m.id DESC LIMIT 30`);
  return { counts: c, orders, recent, enabled: await T.switchOn() };
}

module.exports = { quote, startOrder, onPaid, notifyPaid, dispatch, overview };
