/**
 * src/jobs/customerMail.js — the customer emails, on a timer (user, 2026-09-21).
 *
 * Every minute:
 *   1. confirmation emails waiting to go (any time of day — someone is waiting)
 *   2. from customer_email_hour_ist (7 pm) until customer_email_until_hour_ist:
 *        daily   every paying customer, once a day
 *        digest  every signed-in customer without an active purchase, once
 *                every customer_email_free_every_days (4) days, while they
 *                have checked something in the last customer_email_free_active_days
 *
 * customer_emails is what guarantees once: one row per customer, kind and day,
 * claimed before sending. A failed send is retried on a later tick, up to five
 * times; a skipped one (test mode) is not.
 *
 * Only confirmed, subscribed, active accounts are mailed. The content rules live
 * in mail/customer.js.
 */

const db = require('../db');
const settings = require('../util/settings');
const billing = require('../pay/billing');
const C = require('../mail/customer');

const MAX_ATTEMPTS = 5;
const istNow = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const istToday = () => istNow().toISOString().slice(0, 10);

const MAILABLE = `u.email IS NOT NULL AND u.email_verified_at IS NOT NULL
  AND u.email_unsubscribed_at IS NULL AND u.deactivated_at IS NULL AND NOT u.is_paused`;
const PAYING = `EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.is_active
                          AND s.ends_on >= CURRENT_DATE AND s.vehicle_id IS NOT NULL)`;

async function settle(id, out) {
  await db.query(
    `UPDATE customer_emails SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() END
      WHERE id = $1`,
    [id, out.ok ? 'sent' : out.skipped ? 'skipped' : 'failed', out.ok ? null : String(out.error || '').slice(0, 500)]);
  if (!out.ok && !out.skipped) console.warn('[customer-mail] send failed: %s', out.error);
}

/** Claim today's (kind) email for a customer; null if already sent, skipped or given up. */
async function claim(userId, kind, to, day) {
  return db.one(
    `INSERT INTO customer_emails (user_id, kind, to_email, ist_date, attempts) VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (user_id, kind, ist_date) WHERE kind IN ('daily', 'digest')
     DO UPDATE SET attempts = customer_emails.attempts + 1, to_email = EXCLUDED.to_email
       WHERE customer_emails.status = 'failed' AND customer_emails.attempts < ${MAX_ATTEMPTS}
     RETURNING id`, [userId, kind, to, day]);
}

/* ───────────────────────────────────────────────────────── confirmations ── */

async function confirmations(limit = 20) {
  // HELD IN TEST MODE, NOT DROPPED: a customer who gives an address while test
  // mode is on gets their confirmation link the moment test mode is switched
  // off (within 30 days) — otherwise they could never be mailed at all.
  const only = await C.onlyTo();
  const { rows } = await db.query(
    `SELECT e.id, e.to_email, u.id AS user_id, u.email, u.email_token, u.email_verified_at, u.display_name
       FROM customer_emails e JOIN users u ON u.id = e.user_id
      WHERE e.kind = 'confirm' AND e.status IN ('pending', 'failed') AND e.attempts < ${MAX_ATTEMPTS}
        AND e.created_at > now() - interval '30 days'
        AND (cardinality($2::text[]) = 0 OR lower(e.to_email) = ANY($2::text[]))
      ORDER BY e.id LIMIT $1`, [limit, only]);
  let sent = 0;
  for (const r of rows) {
    // The address changed again, or was confirmed already: this one is moot.
    if (String(r.email || '').toLowerCase() !== String(r.to_email).toLowerCase() || r.email_verified_at) {
      await db.query(`UPDATE customer_emails SET status = 'skipped', error = 'superseded' WHERE id = $1`, [r.id]);
      continue;
    }
    await db.query(`UPDATE customer_emails SET attempts = attempts + 1 WHERE id = $1`, [r.id]);
    const mail = C.confirmMail(r);
    await db.query(`UPDATE customer_emails SET subject = $2 WHERE id = $1`, [r.id, mail.subject]);
    const out = await C.deliver(r.to_email, mail, null);
    await settle(r.id, out);
    if (out.ok) sent += 1;
  }
  return sent;
}

/* ─────────────────────────────────────────────────────────── daily (paid) ── */

async function dailyFor(u, day) {
  const { rows: subs } = await db.query(
    `SELECT s.vehicle_id, max(s.ends_on) AS ends_on
       FROM subscriptions s
      WHERE s.user_id = $1 AND s.is_active AND s.ends_on >= CURRENT_DATE AND s.vehicle_id IS NOT NULL
      GROUP BY s.vehicle_id`, [u.id]);
  const paid = [];
  for (const s of subs) {
    const record = await C.storedRecord(s.vehicle_id);
    if (record) paid.push({ record, alertsUntil: s.ends_on, vehicleId: s.vehicle_id });
  }
  if (!paid.length) return null;

  const { rows: changes } = await db.query(
    `SELECT id, reg_no, text FROM pending_alerts
      WHERE user_id = $1 AND emailed_at IS NULL AND created_at > now() - interval '7 days'
      ORDER BY reg_no, id`, [u.id]);

  const activeDays = await settings.num('customer_email_free_active_days', 90);
  const { rows: other } = await db.query(
    `SELECT uv.vehicle_id FROM user_vehicles uv
      WHERE uv.user_id = $1 AND uv.last_checked_at > now() - ($2 || ' days')::interval
        AND NOT (uv.vehicle_id = ANY($3::bigint[]))
      ORDER BY uv.last_checked_at DESC LIMIT 3`, [u.id, String(activeDays), paid.map((p) => p.vehicleId)]);
  const others = [];
  for (const o of other) { const r = await C.storedRecord(o.vehicle_id); if (r) others.push(r); }

  return { mail: C.dailyMail(u, { paid, changes, others }), changes, regs: paid.map((p) => p.record.vehicle_number) };
}

async function daily(day, limit) {
  const { rows: people } = await db.query(
    `SELECT u.* FROM users u
      WHERE ${MAILABLE} AND ${PAYING}
        AND NOT EXISTS (SELECT 1 FROM customer_emails e WHERE e.user_id = u.id AND e.kind = 'daily'
                          AND e.ist_date = $1 AND (e.status IN ('sent', 'skipped') OR e.attempts >= ${MAX_ATTEMPTS}))
      ORDER BY u.id LIMIT $2`, [day, limit]);
  let sent = 0;
  for (const u of people) {
    const row = await claim(u.id, 'daily', u.email, day);
    if (!row) continue;
    let built;
    try { built = await dailyFor(u, day); } catch (e) { await settle(row.id, { ok: false, error: `build: ${e.message}` }); continue; }
    if (!built) { await settle(row.id, { ok: false, skipped: true, error: 'no stored record for a paid vehicle' }); continue; }
    await db.query(`UPDATE customer_emails SET subject = $2, vehicles = $3 WHERE id = $1`,
      [row.id, built.mail.subject, JSON.stringify(built.regs)]);
    const out = await C.deliver(u.email, built.mail, u.email_token);
    await settle(row.id, out);
    if (out.ok) {
      if (built.changes.length) {
        await db.query(`UPDATE pending_alerts SET emailed_at = now() WHERE id = ANY($1::bigint[])`, [built.changes.map((c) => c.id)]);
      }
      sent += 1;
    }
  }
  return sent;
}

/* ────────────────────────────────────────────────────────── digest (free) ── */

async function digest(day, limit) {
  const every = Math.max(1, await settings.num('customer_email_free_every_days', 4));
  const activeDays = await settings.num('customer_email_free_active_days', 90);
  const { rows: people } = await db.query(
    `SELECT u.* FROM users u
      WHERE ${MAILABLE} AND NOT ${PAYING}
        AND EXISTS (SELECT 1 FROM user_vehicles uv WHERE uv.user_id = u.id
                      AND uv.last_checked_at > now() - ($2 || ' days')::interval
                      AND uv.last_checked_at < now() - interval '2 hours')
        AND NOT EXISTS (SELECT 1 FROM customer_emails e WHERE e.user_id = u.id AND e.kind = 'digest'
                          AND e.ist_date > ($1::date - $3::int)
                          AND (e.status IN ('sent', 'skipped') OR e.attempts >= ${MAX_ATTEMPTS}))
      ORDER BY u.id LIMIT $4`, [day, String(activeDays), every, limit]);
  const plan = await billing.reportPlan().catch(() => null);
  let sent = 0;
  for (const u of people) {
    const row = await claim(u.id, 'digest', u.email, day);
    if (!row) continue;
    const { rows: vs } = await db.query(
      `SELECT uv.vehicle_id FROM user_vehicles uv
        WHERE uv.user_id = $1 AND uv.last_checked_at > now() - ($2 || ' days')::interval
        ORDER BY uv.last_checked_at DESC LIMIT 5`, [u.id, String(activeDays)]);
    const records = [];
    for (const v of vs) { const r = await C.storedRecord(v.vehicle_id); if (r) records.push(r); }
    if (!records.length) { await settle(row.id, { ok: false, skipped: true, error: 'no stored record' }); continue; }
    const mail = C.digestMail({ ...u, price_paise: plan?.price_paise }, records);
    await db.query(`UPDATE customer_emails SET subject = $2, vehicles = $3 WHERE id = $1`,
      [row.id, mail.subject, JSON.stringify(records.map((r) => r.vehicle_number))]);
    const out = await C.deliver(u.email, mail, u.email_token);
    await settle(row.id, out);
    if (out.ok) sent += 1;
  }
  return sent;
}

/* ──────────────────────────────────────────────────────────────── loop ── */

async function runOnce({ force = false } = {}) {
  if (String(await settings.get('customer_email_enabled', 'true')).toLowerCase() === 'false') return { off: true };
  const confirmSent = await confirmations();
  const from = await settings.num('customer_email_hour_ist', 19);
  const until = await settings.num('customer_email_until_hour_ist', 22);
  const hour = istNow().getUTCHours();
  if (!force && (hour < from || hour >= until)) return { confirm: confirmSent, daily: 0, digest: 0 };
  const limit = Math.max(1, await settings.num('customer_email_per_tick', 10));
  const day = istToday();
  const dailySent = await daily(day, limit);
  const digestSent = await digest(day, limit);
  if (confirmSent || dailySent || digestSent) {
    console.log('[customer-mail] confirm %d · daily %d · digest %d', confirmSent, dailySent, digestSent);
  }
  return { confirm: confirmSent, daily: dailySent, digest: digestSent };
}

function start(everySeconds = 60) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runOnce(); } catch (e) { console.error('[customer-mail] pass failed:', e.message); }
    finally { running = false; }
  };
  setInterval(tick, everySeconds * 1000).unref();
  setTimeout(tick, 5000).unref();
  console.log(`  customer email job: every ${everySeconds}s`);
}

module.exports = { start, runOnce, confirmations, daily, digest, dailyFor };
