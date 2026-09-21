/**
 * src/quizpe/readonly.js — GaadiPe's window into QuizPe, READ-ONLY (user, 2026-09-21).
 *
 * Used for one thing: to see whether a parent a GaadiPe customer referred has
 * joined QuizPe and bought a premium plan. QuizPe's code is not touched and
 * nothing here can change QuizPe:
 *
 *   * its own login (QUIZPE_RO_*), which the server grants SELECT on a few
 *     columns only — see scripts/quizpe-readonly.sql
 *   * every session is read-only as well (default_transaction_read_only), so
 *     even a mis-granted login could not write
 *   * short statement timeout and a pool of two, so a slow query never loads
 *     QuizPe's database
 *
 * Not configured (no QUIZPE_RO_DATABASE) means the referral check simply does
 * not run; nothing else depends on it.
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

/**
 * For these ten-digit mobiles: each QuizPe parent (when they joined) and each
 * captured premium payment of at least `minRupees`, with when it was paid.
 * A trial has a subscription but no invoice or payment, so it never appears as
 * a payment.
 */
async function lookup(mobiles, minRupees = 99) {
  const p = get();
  if (!p || !mobiles.length) return { parents: [], payments: [] };
  const DIGITS = `right(regexp_replace(p.parent_mobile_number, '[^0-9]', '', 'g'), 10)`;
  const parents = await p.query(
    `SELECT p.id, ${DIGITS} AS mobile, p.created_at
       FROM parents p
      WHERE ${DIGITS} = ANY($1::text[])`, [mobiles]);
  const payments = await p.query(
    `SELECT p.id AS parent_id, ${DIGITS} AS mobile, pay.payment_id, pay.amount, i.created_at AS paid_at
       FROM parents p
       JOIN parents_quizpe_subscriptions s ON s.parent_id = p.id
       JOIN invoices i ON i.subscription_id = s.id
       JOIN payments pay ON pay.id = i.payment_id
      WHERE ${DIGITS} = ANY($1::text[])
        AND pay.captured = true AND pay.amount >= $2
      ORDER BY i.created_at`, [mobiles, minRupees]);
  return { parents: parents.rows, payments: payments.rows };
}

module.exports = { configured, lookup };
