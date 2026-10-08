/**
 * src/admin/totals.js — THE WHOLE STORY SO FAR (user, 2026-10-08, Live users:
 * "total customers count, vs signed in, vs converted — day 1 till today, and
 * compared with yesterday").
 *
 * Three groups, each counted once per person, from the first day there is data:
 *   visitors   everyone who opened gaadipe.in (visitors.first_seen_at)
 *   signed_in  every customer account (users.created_at)
 *   converted  customers with a real paid purchase — the first one counts
 *              (payments paid, amount > 0: the owner's ₹0 test buys never do)
 * The owner's own devices and account are left out (admin/notMe).
 *
 * For each: the total now, the total at the end of yesterday, and how many were
 * new today and new yesterday — days in India time.
 */
const db = require('../db');
const notMe = require('./notMe');

const TODAY = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
const YESTERDAY = `(${TODAY} - interval '1 day')`;

const block = (from, at, where) => `(SELECT json_build_object(
    'total',      count(*),
    'today',      count(*) FILTER (WHERE ${at} >= ${TODAY}),
    'yesterday',  count(*) FILTER (WHERE ${at} >= ${YESTERDAY} AND ${at} < ${TODAY}),
    'first_day',  min(${at}))
  FROM ${from} WHERE ${where})`;

async function all() {
  const row = await db.one(`SELECT
    ${block('visitors', 'first_seen_at', notMe.visitor('visitor_id'))} AS visitors,
    ${block('users', 'created_at', `NOT is_internal`)} AS signed_in,
    ${block(`(SELECT p.user_id, min(p.paid_at) AS first_paid FROM payments p
               JOIN users u ON u.id = p.user_id
              WHERE p.status = 'paid' AND p.amount_paise > 0 AND p.paid_at IS NOT NULL AND NOT u.is_internal
              GROUP BY p.user_id) c`, 'first_paid', 'true')} AS converted`);

  const shape = (b) => {
    const total = Number(b?.total || 0);
    const today = Number(b?.today || 0);
    const yesterday = Number(b?.yesterday || 0);
    return { total, until_yesterday: total - today, today, yesterday, first_day: b?.first_day || null };
  };
  const visitors = shape(row.visitors);
  const signedIn = shape(row.signed_in);
  const converted = shape(row.converted);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    visitors, signed_in: signedIn, converted,
    // How each step turns into the next — over all time, and for today alone.
    rates: {
      sign_in_rate: pct(signedIn.total, visitors.total),
      buy_rate: pct(converted.total, signedIn.total),
      sign_in_rate_today: pct(signedIn.today, visitors.today),
      buy_rate_today: pct(converted.today, signedIn.today),
    },
    at: new Date().toISOString(),
  };
}

module.exports = { all };
