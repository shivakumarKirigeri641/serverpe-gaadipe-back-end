/**
 * src/util/settings.js
 * ---------------------------------------------------------------------------
 * Values that change without a deploy.
 *
 * Prices, trial length, check frequency and the "never show this" switches all
 * live in app_settings rather than in code, so a test run can set
 * trial_minutes=1 and exercise the exact same code path production runs at
 * 10080. A test that runs different code from production tests nothing.
 *
 * Cached for a minute: these are read on every inbound message and every pass
 * of the watch job, and none of them change more than a few times a year — but
 * when one does change, waiting a minute is not waiting for a restart.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');

const TTL_MS = 60 * 1000;
let cache = null;
let cachedAt = 0;

async function all() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const { rows } = await db.query('SELECT key, value FROM app_settings');
  cache = Object.fromEntries(rows.map(r => [r.key, r.value]));
  cachedAt = Date.now();
  return cache;
}

/** Drop the cache — used after an admin edits a setting. */
const refresh = () => { cache = null; };

async function get(key, fallback = null) {
  const s = await all();
  return s[key] ?? fallback;
}

async function num(key, fallback) {
  const v = Number(await get(key, fallback));
  return Number.isFinite(v) ? v : fallback;
}

async function bool(key, fallback = false) {
  const v = await get(key, null);
  return v === null ? fallback : /^(1|true|yes|on)$/i.test(String(v));
}

module.exports = { all, get, num, bool, refresh };
