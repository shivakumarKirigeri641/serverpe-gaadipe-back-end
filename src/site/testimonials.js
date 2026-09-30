/**
 * src/site/testimonials.js — "What customers say" on gaadipe.in (user,
 * 2026-09-30).
 *
 * Only feedback an admin approved, with the text and name they chose — never a
 * number, never the original message if it was edited. Newest first, at most
 * twelve. Kept for five minutes; approving or removing one clears it at once.
 */

const db = require('../db');

const TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, value: null };

async function list() {
  if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  const { rows } = await db.query(
    `SELECT id, public_name AS name, public_text AS text, rating, approved_at
       FROM feedback
      WHERE approved_at IS NOT NULL AND public_text IS NOT NULL AND public_name IS NOT NULL
      ORDER BY approved_at DESC LIMIT 12`);
  const value = rows.map((r) => ({ id: String(r.id), name: r.name, text: r.text, rating: r.rating,
    month: new Date(r.approved_at).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) }));
  cache = { at: Date.now(), value };
  return value;
}

/** An approval or removal happened: the next request reads afresh. */
const forget = () => { cache = { at: 0, value: null }; };

module.exports = { list, forget };
