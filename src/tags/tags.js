/**
 * src/tags/tags.js — GAADIPE TAG, the core (user, 2026-10-29: "communicate between 2 vehicle owners based on vehicle
 * numbers via my platform"; migration 218).
 *
 * An owner makes a tag for their vehicle; its QR opens GaadiPe on WhatsApp ("TAG <code>"). The person who scanned
 * agrees, picks a preset reason, and GaadiPe passes it to the owner; the owner types a reply and it comes back. Neither
 * sees the other's number. ONLY an owner who created a tag can be reached — never anyone looked up from a vehicle
 * database (privacy law, and WhatsApp: a stranger messaging people who never asked is what gets a number banned).
 *
 * HIDDEN UNTIL LAUNCH: tag_enabled (Settings) is OFF; until then only GaadiPe's own numbers (users.is_internal) can make
 * tags, and only their tags can be scanned — so the owner tests end to end from two phones and nobody else sees a thing.
 */
const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');

// No look-alikes: 0/O, 1/I/L, 5/S, 2/Z, 8/B.
const ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY';
const newCode = () => Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join('');
const ten = (m) => String(m || '').replace(/\D/g, '').slice(-10);

/* THE PRESET REASONS (user: "preset only"). title = the WhatsApp list row (24 characters); text = what the owner reads,
   also the SMS value (DLT allows 30). Never free text from the person who scanned. */
const REASONS = [
  { key: 'block',    title: 'Blocking my vehicle',    text: 'Your vehicle is blocking mine' },
  { key: 'lights',   title: 'Headlights are on',      text: 'Headlights are on' },
  { key: 'window',   title: 'Window is open',         text: 'Window is open' },
  { key: 'towed',    title: 'Being towed',            text: 'Vehicle is being towed' },
  { key: 'accident', title: 'Accident or damage',     text: 'Accident or damage' },
  { key: 'come',     title: 'Please come to vehicle', text: 'Please come to your vehicle' },
];
const reasonOf = (key) => REASONS.find((r) => r.key === key) || null;

const switchOn = () => settings.bool('tag_enabled', false);

async function isInternal(mobile) {
  const r = await db.one(
    `SELECT 1 AS yes FROM users WHERE right(regexp_replace(coalesce(mobile, ''), '\\D', '', 'g'), 10) = $1 AND is_internal LIMIT 1`,
    [ten(mobile)]).catch(() => null);
  return Boolean(r);
}

/* Before launch, the numbers in tag_allow_mobiles (migration 219) have tags fully working too — the owner's family. */
async function allowListed(mobile) {
  const list = String(await settings.get('tag_allow_mobiles', '') || '').split(/[\s,]+/).map(ten).filter((m) => m.length === 10);
  return list.includes(ten(mobile));
}

/** May this person make and manage tags? Everyone once switched on; before that, GaadiPe's own and allow-listed numbers. */
async function enabledFor(mobile) {
  return (await switchOn()) || (await allowListed(mobile)) || isInternal(mobile);
}

/** "KA01AB1234" → "KA01••1234": enough to know it's your vehicle, not enough to identify it to a stranger. */
const masked = (reg) => {
  const r = String(reg || '').toUpperCase();
  return r.length >= 8 ? `${r.slice(0, 4)}••${r.slice(-4)}` : r;
};

const waNumber = () => {
  const n = String(process.env.WHATSAPP_BUSINESS_PHONENUMBER || require('../config').config.whatsapp?.ownNumber || '917996083415')
    .replace(/\D/g, '');
  return n.length === 10 ? `91${n}` : n;
};
const base = () => (process.env.PUBLIC_BASE_URL || 'https://api.gaadipe.in').replace(/\/+$/, '');
/** What the QR carries: our own link first (counts the scan, can be switched off), which opens WhatsApp. */
const tagUrl = (code) => `${base()}/t/${code}`;
const waLink = (code) => `https://wa.me/${waNumber()}?text=${encodeURIComponent(`TAG ${code}`)}`;

/** The vehicles this person has with GaadiPe — their own first — for "which vehicle is the tag for?". */
async function vehiclesOf(userId) {
  const { rows } = await db.query(
    `SELECT v.id AS vehicle_id, v.reg_no, v.maker, v.model, uv.relation,
            t.code, t.is_active AS tagged
       FROM user_vehicles uv
       JOIN vehicles v ON v.id = uv.vehicle_id
       LEFT JOIN vehicle_tags t ON t.user_id = uv.user_id AND t.vehicle_id = v.id AND t.is_active
      WHERE uv.user_id = $1 AND uv.hidden_at IS NULL
      ORDER BY (t.id IS NOT NULL) DESC, (uv.relation = 'owned') DESC, uv.last_checked_at DESC
      LIMIT 9`, [userId]);
  return rows;
}

/** This owner's live tag for this vehicle, made now if there is none. */
async function getOrCreate(userId, vehicleId) {
  const have = await db.one(`SELECT * FROM vehicle_tags WHERE user_id = $1 AND vehicle_id = $2 AND is_active`, [userId, vehicleId]);
  if (have) return { tag: have, created: false };
  for (let i = 0; i < 6; i += 1) {
    try {
      const { rows } = await db.query(
        `INSERT INTO vehicle_tags (code, user_id, vehicle_id) VALUES ($1, $2, $3) RETURNING *`, [newCode(), userId, vehicleId]);
      await db.query(`INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'tag_created', $3)`,
        [userId, vehicleId, JSON.stringify({ code: rows[0].code })]).catch(() => {});
      return { tag: rows[0], created: true };
    } catch (e) {
      if (e.code !== '23505') throw e;                 // a code collision: try another; a second live tag: return it
      const again = await db.one(`SELECT * FROM vehicle_tags WHERE user_id = $1 AND vehicle_id = $2 AND is_active`, [userId, vehicleId]);
      if (again) return { tag: again, created: false };
    }
  }
  throw new Error('could not allocate a tag code');
}

/** A tag by its code, with its vehicle and owner — null when unknown. */
async function byCode(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 6) return null;
  return db.one(
    `SELECT t.*, v.reg_no, u.mobile AS owner_mobile, u.is_internal AS owner_internal,
            coalesce(nullif(u.display_name, ''), nullif(u.wa_profile_name, ''), nullif(u.name, '')) AS owner_name
       FROM vehicle_tags t JOIN vehicles v ON v.id = t.vehicle_id JOIN users u ON u.id = t.user_id
      WHERE t.code = $1`, [c]);
}

/** Can this tag be scanned right now? Switched on for everyone, or (hidden) a tag of GaadiPe's own or allow-listed numbers. */
async function live(tag) {
  if (!tag || !tag.is_active) return false;
  return (await switchOn()) || Boolean(tag.owner_internal) || allowListed(tag.owner_mobile);
}

async function recordScan(code) {
  await db.query(`UPDATE vehicle_tags SET scans = scans + 1, last_scan_at = now() WHERE code = $1`, [String(code).toUpperCase()]).catch(() => {});
}

async function switchOff(code, userId) {
  const { rowCount } = await db.query(
    `UPDATE vehicle_tags SET is_active = false, deactivated_at = now() WHERE code = $1 AND user_id = $2 AND is_active`, [code, userId]);
  return rowCount > 0;
}

/** Why this sender cannot reach this tag now, or null when they can. Limits are settings (start loose). */
async function refusal(tag, senderMobile) {
  const s = ten(senderMobile);
  if (s === ten(tag.owner_mobile)) return 'own';
  const blocked = await db.one(`SELECT 1 AS x FROM tag_blocks WHERE owner_user_id = $1 AND sender_mobile = $2`, [tag.user_id, s]);
  if (blocked) return 'blocked';
  const perHour = await settings.num('tag_limit_per_vehicle_hour', 10);
  const perDay = await settings.num('tag_limit_per_sender_day', 30);
  const c = await db.one(
    `SELECT (SELECT count(*) FROM tag_messages WHERE tag_id = $1 AND created_at > now() - interval '1 hour')::int AS hour,
            (SELECT count(*) FROM tag_messages WHERE sender_mobile = $2 AND created_at > now() - interval '1 day')::int AS day`,
    [tag.id, s]);
  if (c.hour >= perHour) return 'vehicle_limit';
  if (c.day >= perDay) return 'sender_limit';
  return null;
}

/* WHAT AN OWNER MAY SAY BACK (user: "typable — we can't predict what the owner may be doing"). Their own words, as
   typed; only links and abuse are held back, so the reply can never be used for a scam or to insult. */
const ABUSE = /\b(f+u+c+k+\w*|bitch\w*|bastard\w*|asshole\w*|mother ?f\w*|madarchod|behenchod|bhenchod|chutiya\w*|gaand\w*|randi\w*|harami\w*|kutta|kutti|saala|saali|bsdk|mc|bc)\b/i;
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|net|org|io|me|co|xyz|app|link|ly)\b)/i;
function replyProblem(text) {
  const t = String(text || '').trim();
  if (!t) return 'empty';
  if (t.length > 300) return 'long';
  if (LINK.test(t)) return 'link';
  if (ABUSE.test(t)) return 'abuse';
  return null;
}

module.exports = { REASONS, reasonOf, enabledFor, switchOn, isInternal, allowListed, masked, tagUrl, waLink, waNumber, vehiclesOf,
  getOrCreate, byCode, live, recordScan, switchOff, refusal, replyProblem, ten };
