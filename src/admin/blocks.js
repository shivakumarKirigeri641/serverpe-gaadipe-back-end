/**
 * src/admin/blocks.js — mobile numbers and vehicles GaadiPe will not serve.
 *
 * A block is worth nothing unless the bot obeys it, so there is ONE question
 * asked in one place — `isBlocked(kind, value)` — and the conversation, the
 * lookup and the watch job all ask it. Two implementations would mean a number
 * blocked in the panel that still gets alerts at 6am.
 *
 * WHAT EACH KIND MEANS:
 *   mobile   the person is not answered, not alerted, and cannot pay. Their
 *            messages are still recorded: a blocked number that abuses the
 *            service is exactly the one whose messages we may need later.
 *   vehicle  this registration is not looked up or sold, for anybody. Used
 *            when an owner objects to their vehicle being checked, which is a
 *            request we must be able to honour under the DPDP Act.
 *
 * Released rather than deleted, so "who blocked this, when, and who let it back
 * in" survives.
 */

const db = require('../db');
const { audit } = require('./auth');

const clean = {
  mobile: (v) => String(v || '').replace(/\D/g, '').slice(-10),
  vehicle: (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
};

/**
 * Is this blocked right now?
 *
 * Cached for a few seconds because the bot asks on every inbound message and
 * the watch job asks once per vehicle per pass — but short enough that
 * unblocking someone in the panel takes effect while they are still typing.
 */
const CACHE_MS = 5000;
let cache = { at: 0, mobiles: new Set(), vehicles: new Set() };

async function live() {
  if (Date.now() - cache.at < CACHE_MS) return cache;
  const { rows } = await db.query(
    `SELECT kind, value FROM blocks WHERE released_at IS NULL`);
  cache = {
    at: Date.now(),
    mobiles: new Set(rows.filter(r => r.kind === 'mobile').map(r => r.value)),
    vehicles: new Set(rows.filter(r => r.kind === 'vehicle').map(r => r.value)),
  };
  return cache;
}

async function isBlocked(kind, value) {
  const v = (clean[kind] || String)(value);
  if (!v) return false;
  const c = await live();
  return kind === 'mobile' ? c.mobiles.has(v) : c.vehicles.has(v);
}

/** Both at once, for the one place that needs to ask about a person AND a plate. */
async function anyBlocked({ mobile, regNo } = {}) {
  if (mobile && await isBlocked('mobile', mobile)) return 'mobile';
  if (regNo && await isBlocked('vehicle', regNo)) return 'vehicle';
  return null;
}

async function list({ kind = null, includeReleased = false, limit = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT b.id, b.kind, b.value, b.reason, b.created_at, b.released_at,
            a.name AS blocked_by_name, r.name AS released_by_name
       FROM blocks b
       LEFT JOIN admin_users a ON a.id = b.blocked_by
       LEFT JOIN admin_users r ON r.id = b.released_by
      WHERE ($1::text IS NULL OR b.kind = $1)
        AND ($2::boolean OR b.released_at IS NULL)
      ORDER BY b.created_at DESC
      LIMIT $3`, [kind, includeReleased, limit]);
  return rows.map(r => ({ ...r, id: String(r.id) }));
}

async function block({ kind, value, reason, adminId, ip }) {
  const v = (clean[kind] || String)(value);
  if (!v) return { ok: false, message: 'Nothing to block.' };
  if (kind === 'mobile' && v.length !== 10) {
    return { ok: false, message: 'A ten-digit mobile number is required.' };
  }

  const { rows } = await db.query(
    `INSERT INTO blocks (kind, value, reason, blocked_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (kind, value) WHERE released_at IS NULL DO NOTHING
     RETURNING *`, [kind, v, reason || null, adminId || null]);

  cache.at = 0;
  await audit({ adminId, action: 'block', ip, detail: { kind, value: v, reason: reason || null } });
  return { ok: true, already: !rows[0], block: rows[0] ? { ...rows[0], id: String(rows[0].id) } : null };
}

async function release({ id, adminId, ip }) {
  const { rows } = await db.query(
    `UPDATE blocks SET released_at = now(), released_by = $2
      WHERE id = $1 AND released_at IS NULL RETURNING *`, [id, adminId || null]);
  cache.at = 0;
  if (!rows[0]) return { ok: false, message: 'That block is already released.' };
  await audit({ adminId, action: 'unblock', ip,
                detail: { kind: rows[0].kind, value: rows[0].value } });
  return { ok: true };
}

module.exports = { isBlocked, anyBlocked, list, block, release };
