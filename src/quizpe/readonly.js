/**
 * src/quizpe/readonly.js — GaadiPe's window into QuizPe, READ-ONLY (user, 2026-09-21).
 *
 * Used for one thing: the referral link. Two views in QuizPe's database, made by
 * scripts/quizpe-readonly.sql, are all this login can read:
 *
 *   gaadipe_ref_messages       who sent a "GP-<code>" message to QuizPe, and when
 *   gaadipe_premium_payments   captured premium payments of those numbers only
 *
 * Every session is read-only as well, with a short statement timeout and a pool
 * of two, so this can neither change nor load QuizPe. QuizPe's code is untouched.
 * Not configured (no QUIZPE_RO_DATABASE) means the referral check waits.
 */

const { Pool } = require('pg');

let pool = null;

const configured = () => Boolean(process.env.QUIZPE_RO_DATABASE && process.env.QUIZPE_RO_USER);

function get() {
  if (!configured()) return null;
  if (!pool) {
    pool = new Pool({
      host: process.env.QUIZPE_RO_HOST || process.env.PGHOST || 'localhost',
      port: Number(process.env.QUIZPE_RO_PORT || process.env.PGPORT || 5432),
      database: process.env.QUIZPE_RO_DATABASE,
      user: process.env.QUIZPE_RO_USER,
      password: process.env.QUIZPE_RO_PASSWORD,
      max: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
      application_name: 'gaadipe-referral-readonly',
      options: '-c default_transaction_read_only=on -c statement_timeout=10000',
    });
    pool.on('error', (e) => console.warn('[quizpe-ro] idle client error:', e.message));
  }
  return pool;
}

/** Messages carrying a GaadiPe code since `since`: [{ mobile, code, created_at }], oldest first. */
async function refMessages(since) {
  const p = get();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT mobile, code, created_at FROM gaadipe_ref_messages
      WHERE created_at >= $1 ORDER BY created_at LIMIT 5000`, [since]);
  return rows;
}

/** Captured premium payments of these numbers: [{ mobile, payment_id, amount, paid_at, plan_start_date, plan_end_date }]. */
async function premiumPayments(mobiles) {
  const p = get();
  if (!p || !mobiles.length) return [];
  const { rows } = await p.query(
    `SELECT mobile, payment_id, amount, paid_at, plan_start_date, plan_end_date
       FROM gaadipe_premium_payments WHERE mobile = ANY($1::text[]) ORDER BY paid_at`, [mobiles]);
  return rows;
}

module.exports = { configured, refMessages, premiumPayments };
