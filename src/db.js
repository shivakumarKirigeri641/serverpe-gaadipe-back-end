/**
 * src/db.js
 * ---------------------------------------------------------------------------
 * One Postgres pool for the process, plus the two helpers every caller uses.
 *
 * `tx` exists so a multi-statement write is atomic without every caller
 * hand-rolling BEGIN/COMMIT/ROLLBACK and forgetting the release on the error
 * path — the classic way a pool leaks connections until the app stops
 * responding under load.
 * ---------------------------------------------------------------------------
 */

const { Pool } = require('pg');
const { config } = require('./config');

const pool = new Pool(config.db);

// Emitted for idle clients dropped by the server or a network blip. Without a
// listener Node treats it as an unhandled 'error' event and kills the process.
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

const SLOW_MS = 1000;

async function query(text, params) {
  const started = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - started;
  if (ms > SLOW_MS) {
    console.warn(`[db] slow ${ms}ms: ${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  }
  return res;
}

/** Run `fn` in a transaction. Always releases; any throw rolls back. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

/** First row or null — the shape most lookups actually want. */
const one = async (text, params) => (await query(text, params)).rows[0] || null;

module.exports = { pool, query, tx, one, close: () => pool.end() };
