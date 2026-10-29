/**
 * src/tags/admin.js — THE ADMIN'S GAADIPE TAG SECTION (user, 2026-10-29: "in admin panel, sync this properly with full
 * fledged working & monitoring, separate section"). Read and manage every tag; make tags for a customer (by mobile and
 * vehicle numbers) and download their print sheet; switch a tag off or on; lift a block. Overview and sticker orders:
 * tags/orders.js. The switch, allow-list, limits and prices are app_settings rows (saved through PUT /settings).
 */
const db = require('../db');
const settings = require('../util/settings');
const T = require('./tags');

const SETTING_KEYS = ['tag_enabled', 'tag_allow_mobiles', 'tag_limit_per_vehicle_hour', 'tag_limit_per_sender_day',
  'tag_zone_city', 'tag_zone_state', 'tag_zone_india', 'tag_zone_remote', 'tag_pickup_pincode',
  'tag_alert_template', 'tag_shipped_template', 'sms_tpl_tag_alert', 'sms_tpl_tag_shipped'];

async function list({ q = '' } = {}) {
  const term = String(q || '').trim().toUpperCase().replace(/\s+/g, '');
  const { rows } = await db.query(
    `SELECT t.id, t.code, t.is_active, t.scans, t.last_scan_at, t.created_at, t.deactivated_at, v.reg_no, u.id AS user_id, u.mobile,
            coalesce(nullif(u.display_name, ''), nullif(u.wa_profile_name, ''), nullif(u.name, '')) AS owner_name, u.is_internal,
            (SELECT count(*) FROM tag_messages m WHERE m.tag_id = t.id)::int AS messages,
            (SELECT max(created_at) FROM tag_messages m WHERE m.tag_id = t.id) AS last_message_at,
            (SELECT count(*) FROM tag_orders o WHERE o.tag_id = t.id AND o.status IN ('paid', 'dispatched'))::int AS stickers
       FROM vehicle_tags t JOIN vehicles v ON v.id = t.vehicle_id JOIN users u ON u.id = t.user_id
      WHERE ($1 = '' OR v.reg_no LIKE '%' || $1 || '%' OR t.code = $1 OR u.mobile LIKE '%' || $1 || '%')
      ORDER BY t.is_active DESC, t.created_at DESC LIMIT 300`, [term]);
  const allow = String(await settings.get('tag_allow_mobiles', '') || '');
  const on = await T.switchOn();
  return rows.map((r) => ({ ...r, id: String(r.id), user_id: String(r.user_id),
    reachable: r.is_active && (on || r.is_internal || allow.includes(T.ten(r.mobile))) }));
}

async function messages() {
  const { rows } = await db.query(
    `SELECT m.id, m.reason, m.status, m.channel, m.error, m.replies, m.last_reply, m.last_reply_at, m.created_at,
            right(m.sender_mobile, 4) AS sender_last4, t.code, v.reg_no, u.mobile AS owner_mobile,
            EXISTS (SELECT 1 FROM tag_blocks b WHERE b.owner_user_id = t.user_id AND b.sender_mobile = m.sender_mobile) AS blocked
       FROM tag_messages m JOIN vehicle_tags t ON t.id = m.tag_id JOIN vehicles v ON v.id = t.vehicle_id JOIN users u ON u.id = t.user_id
      ORDER BY m.id DESC LIMIT 200`);
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

async function blocks() {
  const { rows } = await db.query(
    `SELECT b.id, b.reported, b.created_at, right(b.sender_mobile, 4) AS sender_last4, u.mobile AS owner_mobile,
            coalesce(nullif(u.display_name, ''), nullif(u.wa_profile_name, '')) AS owner_name, m.reason,
            (SELECT string_agg(v.reg_no, ', ') FROM vehicle_tags t JOIN vehicles v ON v.id = t.vehicle_id WHERE t.user_id = b.owner_user_id AND t.is_active) AS vehicles
       FROM tag_blocks b JOIN users u ON u.id = b.owner_user_id LEFT JOIN tag_messages m ON m.id = b.message_id
      ORDER BY b.reported DESC, b.id DESC LIMIT 200`);
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

async function unblock(id) {
  const { rowCount } = await db.query(`DELETE FROM tag_blocks WHERE id = $1`, [Number(id) || 0]);
  return { ok: rowCount > 0 };
}

/**
 * Tags for a customer: their mobile and one or more vehicle numbers. The customer and vehicle are added if new (no
 * lookup of any provider — only the number), the vehicle is marked as theirs, and a tag is made (or the live one kept).
 * allow: also put the mobile on tag_allow_mobiles, so it works before launch.
 */
async function create({ mobile, regs = [], allow = true }) {
  const m = T.ten(mobile);
  if (m.length !== 10) return { ok: false, error: 'Give a 10-digit mobile number.' };
  const plates = [...new Set((Array.isArray(regs) ? regs : String(regs).split(/[\s,]+/))
    .map((r) => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean))];
  if (!plates.length) return { ok: false, error: 'Give at least one vehicle number.' };
  const bad = plates.filter((r) => !/^[A-Z0-9]{5,11}$/.test(r));
  if (bad.length) return { ok: false, error: `Not a vehicle number: ${bad.join(', ')}` };

  // An existing customer is used as they are (no "last seen" touched); a new number is added the usual way.
  const user = (await db.one(`SELECT * FROM users WHERE mobile = $1`, [m]))
    || await require('../vehicle/store').upsertUser(m, { channel: 'whatsapp' });
  const made = [];
  for (const reg of plates) {
    await db.query(`INSERT INTO vehicles (reg_no) VALUES ($1) ON CONFLICT (reg_no) DO NOTHING`, [reg]);
    const v = await db.one(`SELECT id FROM vehicles WHERE reg_no = $1`, [reg]);
    await db.query(
      `INSERT INTO user_vehicles (user_id, vehicle_id, relation) VALUES ($1, $2, 'owned')
       ON CONFLICT (user_id, vehicle_id) DO UPDATE SET relation = 'owned', hidden_at = NULL`, [user.id, v.id]);
    const { tag, created } = await T.getOrCreate(user.id, v.id);
    made.push({ code: tag.code, reg_no: reg, created });
  }
  if (allow && !(await T.switchOn())) {
    const cur = String(await settings.get('tag_allow_mobiles', '') || '').split(/[\s,]+/).map(T.ten).filter((x) => x.length === 10);
    if (!cur.includes(m)) {
      await db.query(`UPDATE app_settings SET value = $1, modified_at = now() WHERE key = 'tag_allow_mobiles'`, [[...cur, m].join(',')]);
      settings.refresh();
    }
  }
  return { ok: true, mobile: m, tags: made };
}

async function setActive(code, on) {
  const c = String(code || '').toUpperCase();
  if (!on) {
    const { rowCount } = await db.query(`UPDATE vehicle_tags SET is_active = false, deactivated_at = now() WHERE code = $1 AND is_active`, [c]);
    return { ok: rowCount > 0 };
  }
  try {
    const { rowCount } = await db.query(`UPDATE vehicle_tags SET is_active = true, deactivated_at = NULL WHERE code = $1 AND NOT is_active`, [c]);
    return { ok: rowCount > 0 };
  } catch (e) {
    if (e.code === '23505') return { ok: false, error: 'This vehicle already has another live tag for the same owner.' };
    throw e;
  }
}

/** The print sheet for these tag codes (A4, four cards a page, `copies` of each). */
async function sheet(codes, copies = 2) {
  const want = [...new Set(String(codes || '').toUpperCase().split(/[\s,]+/).filter((x) => /^[A-Z0-9]{6}$/.test(x)))];
  if (!want.length) return null;
  const tags = [];
  for (const c of want) {
    const t = await T.byCode(c);
    if (t) tags.push(t);
  }
  if (!tags.length) return null;
  return require('./qr').sheetPdf(tags, { copies });
}

async function settingsView() {
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [SETTING_KEYS]);
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, rows.find((r) => r.key === k)?.value ?? null]));
}

module.exports = { list, messages, blocks, unblock, create, setActive, sheet, settingsView, SETTING_KEYS };
