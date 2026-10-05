/**
 * src/util/peer.js — a READ-ONLY window into QuizPe's database (user,
 * 2026-10-05: "do not mix up both dbs").
 *
 * GaadiPe and QuizPe share one Meta messaging limit (250 people in any 24
 * hours), so each needs the other's count to stay under it. That count is all
 * that is read. The pool is opened with default_transaction_read_only=on, so
 * PostgreSQL itself refuses any write; nothing is copied, merged or joined.
 *
 * Off unless PEER_PGDATABASE (QuizPe's database name) is set in .env. Host,
 * port, user and password default to GaadiPe's own (same server).
 */

const { Pool } = require('pg');

let pool = null;
const configured = () => Boolean(process.env.PEER_PGDATABASE);

function get() {
  if (!configured()) return null;
  if (pool) return pool;
  pool = new Pool({
    host: process.env.PEER_PGHOST || process.env.PGHOST,
    port: Number(process.env.PEER_PGPORT || process.env.PGPORT || 5432),
    user: process.env.PEER_PGUSER || process.env.PGUSER,
    password: process.env.PEER_PGPASSWORD || process.env.PGPASSWORD,
    database: process.env.PEER_PGDATABASE,
    max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 4000, statement_timeout: 4000,
    options: '-c default_transaction_read_only=on',
  });
  pool.on('error', (e) => console.error('[peer] pool error:', e.message));
  return pool;
}

async function read(sql, params = []) {
  const p = get();
  if (!p) return null;
  try { return (await p.query(sql, params)).rows; } catch (e) { console.error('[peer] read failed:', e.message); return null; }
}

/** People QuizPe messaged first (templates, not failed) in the last 24 hours, or null when not linked. */
async function quizpeUsed() {
  const r = await read(
    `SELECT count(DISTINCT mobile_number)::int AS n FROM whatsapp_messages
      WHERE direction = 'outbound' AND message_type = 'template' AND created_at > now() - interval '24 hours'
        AND coalesce(status, '') <> 'failed' AND coalesce(error_message, '') = ''`);
  return r ? r[0].n : null;
}

module.exports = { configured, read, quizpeUsed };
