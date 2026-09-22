/**
 * src/jobs/customerMail.js — the customer emails, on a timer (user, 2026-09-21).
 *
 * Every minute:
 *   1. confirmation emails waiting to go (any time of day — someone is waiting)
 *   1b. the thank-you for a purchase, with the report and invoice attached
 *        (any time of day — GaadiPe is web-only, so this is how a buyer is served)
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

const fs = require('fs');
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

/* ──────────────────────────────────────── the thank-you (user, 2026-09-22) ── */

/*
 * Queued by payments.js the moment money is confirmed, sent on the next tick —
 * any time of day, because someone has just paid and is waiting.
 *
 * WHAT IT CARRIES. GaadiPe is web-only for now: there is no WhatsApp number, so
 * the report and invoice that notifyPaid tries to send on WhatsApp reach nobody.
 * This email attaches both PDFs, and is therefore the only thing standing
 * between a paying customer and having nothing to show for it.
 *
 * WAITING FOR THE REPORT. The report is normally issued within seconds of the
 * payment. If the Government records service was slow it may not exist yet, so
 * the first few attempts wait for it; after that the email goes anyway, saying
 * so and pointing at the site, because silence after a payment is the one thing
 * that must not happen.
 */
const WAIT_FOR_REPORT = 3;

async function purchases(limit) {
  const { rows } = await db.query(
    // e.id is NAMED: u.* carries an id of its own that would replace it.
    `SELECT e.id AS email_id, e.attempts, e.payment_id AS pay_id, p.amount_paise, p.paid_at,
            v.reg_no, r.report_number, r.access_token, r.valid_until, r.pdf_path,
            s.ends_on, u.*
       FROM customer_emails e
       JOIN payments p ON p.id = e.payment_id
       JOIN users u ON u.id = e.user_id
       LEFT JOIN vehicles v ON v.id = (p.raw->>'vehicle_id')::bigint
       LEFT JOIN vehicle_reports r ON r.payment_id = p.id
       LEFT JOIN subscriptions s ON s.id = p.subscription_id
      WHERE e.kind = 'purchase' AND e.status IN ('pending', 'failed') AND e.attempts < ${MAX_ATTEMPTS}
        AND e.created_at > now() - interval '30 days'
        AND u.email IS NOT NULL AND u.deactivated_at IS NULL
      ORDER BY e.id LIMIT $1`, [limit]);

  let sent = 0;
  for (const r of rows) {
    // No report yet, and still early: leave it pending and look again next tick.
    if (!r.report_number && r.attempts < WAIT_FOR_REPORT) {
      await db.query(`UPDATE customer_emails SET attempts = attempts + 1 WHERE id = $1`, [r.email_id]);
      continue;
    }
    await db.query(`UPDATE customer_emails SET attempts = attempts + 1, to_email = $2 WHERE id = $1`,
      [r.email_id, r.email]);

    // The invoice is generated here if the payment path could not: the customer
    // is owed it either way, and a missing invoice must not hold up the email.
    let invoice = null;
    try { ({ invoice } = await require('../pay/invoice').forPayment(r.pay_id)); }
    catch (e) { console.warn('[customer-mail] invoice for the purchase email: %s', e.message); }

    const attachments = [];
    if (r.pdf_path && fs.existsSync(r.pdf_path)) attachments.push({ filename: `${r.report_number}.pdf`, path: r.pdf_path });
    if (invoice?.pdf_path && fs.existsSync(invoice.pdf_path)) attachments.push({ filename: `${invoice.invoice_number}.pdf`, path: invoice.pdf_path });

    const mail = C.purchaseMail(r, {
      regNo: r.reg_no,
      amountPaise: r.amount_paise,
      reportNumber: r.report_number,
      reportToken: r.access_token,
      validUntil: r.valid_until,
      alertsUntil: r.ends_on,
      invoiceNumber: invoice?.invoice_number,
      invoiceTotalPaise: invoice?.total_paise,
      confirmed: !!r.email_verified_at,
      attachments,
    });
    await db.query(`UPDATE customer_emails SET subject = $2, vehicles = $3 WHERE id = $1`,
      [r.email_id, mail.subject, JSON.stringify(r.reg_no ? [r.reg_no] : [])]);
    // No unsubscribe token: a receipt for something bought is not a mailing.
    const out = await C.deliver(r.email, mail, null);
    await settle(r.email_id, out);
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
    const detail = String(await settings.get('free_view_detail', 'count')).toLowerCase();
    const mail = C.digestMail({ ...u, price_paise: plan?.price_paise }, records, { detail });
    await db.query(`UPDATE customer_emails SET subject = $2, vehicles = $3 WHERE id = $1`,
      [row.id, mail.subject, JSON.stringify(records.map((r) => r.vehicle_number))]);
    const out = await C.deliver(u.email, mail, u.email_token);
    await settle(row.id, out);
    if (out.ok) sent += 1;
  }
  return sent;
}

/* ───────────────────────────────────── announcements (admin, 2026-09-21) ── */

/*
 * Queued by the admin panel (admin/customerEmails.js). Sent any time of day, a
 * few a minute. The address is checked again at sending: someone who
 * unsubscribed or closed their account after it was queued is skipped.
 */
async function announcements(limit) {
  const { rows } = await db.query(
    // The email row's id is NAMED: u.* has an id of its own that would replace it.
    `SELECT e.id AS email_id, e.campaign_id, e.to_email, c.subject, c.body, u.*
       FROM customer_emails e
       JOIN admin_email_campaigns c ON c.id = e.campaign_id AND c.status = 'queued'
       JOIN users u ON u.id = e.user_id
      WHERE e.kind = 'announcement' AND e.status IN ('pending', 'failed') AND e.attempts < ${MAX_ATTEMPTS}
      ORDER BY e.id LIMIT $1`, [limit]);
  let sent = 0;
  for (const r of rows) {
    const emailId = r.email_id;
    await db.query(`UPDATE customer_emails SET attempts = attempts + 1 WHERE id = $1`, [emailId]);
    if (!r.email || !r.email_verified_at || r.email_unsubscribed_at || r.deactivated_at
        || String(r.email).toLowerCase() !== String(r.to_email).toLowerCase()) {
      await settle(emailId, { ok: false, skipped: true, error: 'no longer subscribed' });
      continue;
    }
    const out = await C.deliver(r.email, C.announcementMail(r, { subject: r.subject, body: r.body }), r.email_token);
    await settle(emailId, out);
    if (out.ok) sent += 1;
  }
  // A campaign with nothing left to send is finished.
  await db.query(
    `UPDATE admin_email_campaigns c SET status = 'sent', finished_at = now()
      WHERE c.status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM customer_emails e WHERE e.campaign_id = c.id
                          AND e.status IN ('pending', 'failed') AND e.attempts < ${MAX_ATTEMPTS})`);
  return sent;
}

/* ──────────────────────────────────────────────────────────────── loop ── */

async function runOnce({ force = false } = {}) {
  if (String(await settings.get('customer_email_enabled', 'true')).toLowerCase() === 'false') return { off: true };
  const confirmSent = await confirmations();
  // Before anything on a timer: someone paid and is waiting for what they bought.
  const bought = await purchases(Math.max(1, await settings.num('customer_email_per_tick', 10)));
  if (bought) console.log('[customer-mail] purchase emails sent %d', bought);
  const announced = await announcements(Math.max(1, await settings.num('customer_email_per_tick', 10)));
  if (announced) console.log('[customer-mail] announcements sent %d', announced);
  const from = await settings.num('customer_email_hour_ist', 19);
  const until = await settings.num('customer_email_until_hour_ist', 22);
  const hour = istNow().getUTCHours();
  if (!force && (hour < from || hour >= until)) return { confirm: confirmSent, purchase: bought, daily: 0, digest: 0 };
  const limit = Math.max(1, await settings.num('customer_email_per_tick', 10));
  const day = istToday();
  const dailySent = await daily(day, limit);
  const digestSent = await digest(day, limit);
  if (confirmSent || dailySent || digestSent) {
    console.log('[customer-mail] confirm %d · daily %d · digest %d', confirmSent, dailySent, digestSent);
  }
  return { confirm: confirmSent, purchase: bought, daily: dailySent, digest: digestSent };
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

module.exports = { start, runOnce, confirmations, purchases, announcements, daily, digest, dailyFor };
