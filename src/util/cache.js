/**
 * src/util/cache.js
 * ---------------------------------------------------------------------------
 * A small in-memory TTL cache.
 *
 * This gateway is deliberately database-free — it should deploy with
 * `npm install && pm2 start`, and the calling application owns persistence.
 * But repeat lookups within a few minutes are common (a page refresh, a
 * retried WhatsApp tap, a dealer pasting the same plate twice), and once ULIP
 * starts charging every avoided call is margin.
 *
 * Negative results are cached too, on purpose: a mistyped plate then costs one
 * API call rather than one per attempt, and the free-check funnel is exactly
 * where strangers type nonsense.
 * ---------------------------------------------------------------------------
 */

const { config } = require('../config');

const store = new Map();   // key -> { value, expiresAt }

/** Evict the oldest entries once the map grows past its cap. */
function trim() {
  if (store.size <= config.cache.maxEntries) return;
  const excess = store.size - config.cache.maxEntries;
  let i = 0;
  for (const k of store.keys()) {
    store.delete(k);
    if (++i >= excess) break;
  }
}

function get(key) {
  if (!config.cache.enabled) return null;
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { store.delete(key); return null; }
  return hit;
}

function set(key, value, minutes) {
  if (!config.cache.enabled) return;
  store.set(key, { value, expiresAt: Date.now() + minutes * 60_000, storedAt: Date.now() });
  trim();
}

const ageMinutes = (hit) => Math.round((Date.now() - hit.storedAt) / 60_000);

function drop(prefix) {
  for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
}

const stats = () => ({ entries: store.size, max: config.cache.maxEntries, enabled: config.cache.enabled });

module.exports = { get, set, drop, stats, ageMinutes };
