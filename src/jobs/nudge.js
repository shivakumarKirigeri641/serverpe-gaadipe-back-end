/**
 * src/jobs/nudge.js — one gentle WhatsApp reminder (user, 2026-09-26).
 *
 * Of the people who say hi, half stop at the terms screen; of the payment
 * links sent, half are never opened. Each of them gets ONE reminder:
 *
 *   terms   still on "terms shown" an hour later  → the Agree button again
 *   number  agreed, but no vehicle number an hour later → what to send
 *   payment latest link still unpaid an hour later → the same link again
 *
 * FREE AND ALLOWED: only inside WhatsApp's 24-hour window after the person's
 * own last message (send.js refuses anything outside it), so no template and
 * no charge. The person messaged first — flow.js's rule still holds.
 *
 * NEVER IN THE WAY of the live conversation: this job only reads sessions,
 * never changes a bot state, and skips anyone who wrote in the last hour. A
 * row is claimed (terms_nudged_at / nudged_at) before sending, so a reminder
 * goes at most once even if two ticks overlap — and never after STOP, never
 * at night (IST), never while WhatsApp or payments are switched off.
 */

const db = require('../db');
const send = require('../whatsapp/send');
const settings = require('../util/settings');
const flags = require('../util/flags');

const PER_TICK = 20;
const SITE = process.env.PUBLIC_SITE_URL || 'https://gaadipe.in';   // as flow.js links the policies
const SITE_BASE = () => (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

function quiet(from, to) {
  const h = new Date(Date.now() + 330 * 60000).getUTCHours();
  return from > to ? h >= from || h < to : h >= from && h < to;
}

function mark(key, name, mobile, userId, meta) {
  require('../events/track').fire({ key, name, channel: 'whatsapp', mobile, userId: userId || null, status: 'ok', meta });
}

async function terms(mins) {
  const due = (await db.query(
    `SELECT id, mobile, user_id FROM whatsapp_sessions
      WHERE state = 'owner_consent' AND terms_nudged_at IS NULL AND wa_opt_out_at IS NULL
        AND modified_at     <= now() - make_interval(mins => $1)
        AND last_inbound_at <= now() - make_interval(mins => $1)
        AND last_inbound_at >  now() - interval '23 hours'
        AND ${NOT_HUSHED('whatsapp_sessions')}
      ORDER BY last_inbound_at LIMIT ${PER_TICK}`, [mins])).rows;
  let sent = 0;
  for (const s of due) {
    // Claim first: whoever gets the row sends; a reply that moved them on
    // since the SELECT means no reminder at all.
    const mine = await db.one(
      `UPDATE whatsapp_sessions SET terms_nudged_at = now()
        WHERE id = $1 AND terms_nudged_at IS NULL AND state = 'owner_consent'
          AND last_inbound_at <= now() - make_interval(mins => $2)
      RETURNING id`, [s.id, mins]);
    if (!mine) continue;
    const out = await send.buttons(s.mobile,
      'Still want to check your vehicle? 🙂\n\n'
      + 'Tap *Agree & continue* below, then send any vehicle number (like KA01XX1234). '
      + 'You will see its insurance, PUC, tax and challan status in seconds.\n\n'
      // What the button agrees to, in the same message as the button (user,
      // 2026-09-28) — not only in the terms screen further up the chat.
      + `By agreeing you accept our Terms (${SITE}/terms), Privacy (${SITE}/privacy) and Refund (${SITE}/refund) policies.\n`
      + '_Reply STOP if you would rather not hear from us._',
      [{ id: 'agree_owner', title: 'Agree & continue' }],
      { footer: 'ServerPe App Solutions' });
    if (out?.ok) { sent += 1; mark(`nudge_terms:${s.id}`, 'whatsapp_reminder_sent', s.mobile, s.user_id, { kind: 'terms' }); }
  }
  return sent;
}

/* Agreed, then went quiet before sending a vehicle number (user, 2026-09-28):
   the most common reason is not knowing what to send. */
/* Held for a day after someone wrote something that was not a vehicle number —
   "You are fraud", "bakwas" (user, 2026-09-30). flow.js stamps no_nudge_at;
   a reminder then is chasing someone who has said no. */
const NOT_HUSHED = (t) =>
  `COALESCE((${t}.context->>'no_nudge_at')::timestamptz, 'epoch') < now() - interval '24 hours'`;

async function number(mins) {
  const due = (await db.query(
    `SELECT id, mobile, user_id FROM whatsapp_sessions
      WHERE state = 'owner_start' AND number_nudged_at IS NULL AND wa_opt_out_at IS NULL
        AND modified_at     <= now() - make_interval(mins => $1)
        AND last_inbound_at <= now() - make_interval(mins => $1)
        AND last_inbound_at >  now() - interval '23 hours'
        AND ${NOT_HUSHED('whatsapp_sessions')}
        -- A customer who has already bought knows how it works (user, 2026-09-30):
        -- a paying customer got "send your number" after using the menu.
        AND NOT EXISTS (SELECT 1 FROM payments x JOIN users u ON u.id = x.user_id
                         WHERE u.mobile = whatsapp_sessions.mobile
                           AND x.status = 'paid' AND x.amount_paise > 0)
      ORDER BY last_inbound_at LIMIT ${PER_TICK}`, [mins])).rows;
  let sent = 0;
  for (const s of due) {
    const mine = await db.one(
      `UPDATE whatsapp_sessions SET number_nudged_at = now()
        WHERE id = $1 AND number_nudged_at IS NULL AND state = 'owner_start'
          AND last_inbound_at <= now() - make_interval(mins => $2)
      RETURNING id`, [s.id, mins]);
    if (!mine) continue;
    const out = await send.text(s.mobile,
      'Ready when you are 🙂\n\n'
      + 'Just send your vehicle number here — like *KA01XX1234* — and I will show its '
      + 'insurance, PUC, tax and challan status in seconds.\n\n'
      + '_Reply STOP if you would rather not hear from us._');
    if (out?.ok) { sent += 1; mark(`nudge_number:${s.id}`, 'whatsapp_reminder_sent', s.mobile, s.user_id, { kind: 'number' }); }
  }
  return sent;
}

async function payments(mins) {
  const base = SITE_BASE();
  if (!base) return 0;
  const due = (await db.query(
    `SELECT p.id, p.user_id, p.amount_paise, p.checkout_token, s.mobile, v.reg_no
       FROM payments p
       JOIN users u             ON u.id = p.user_id
       JOIN whatsapp_sessions s ON s.mobile = u.mobile
       LEFT JOIN vehicles v     ON v.id = (p.raw->>'vehicle_id')::bigint
      WHERE p.status = 'created' AND p.checkout_token IS NOT NULL AND p.nudged_at IS NULL
        AND p.created_at <= now() - make_interval(mins => $1)
        AND p.created_at >  now() - interval '23 hours'
        AND s.state = 'awaiting_payment' AND s.wa_opt_out_at IS NULL
        AND s.last_inbound_at <= now() - make_interval(mins => $1)
        AND s.last_inbound_at >  now() - interval '23 hours'
        AND ${NOT_HUSHED('s')}
        -- only their latest checkout: an older link they replaced stays quiet
        AND NOT EXISTS (SELECT 1 FROM payments q WHERE q.user_id = p.user_id AND q.id > p.id)
      ORDER BY p.created_at LIMIT ${PER_TICK}`, [mins])).rows;
  let sent = 0;
  for (const p of due) {
    const mine = await db.one(
      `UPDATE payments SET nudged_at = now() WHERE id = $1 AND nudged_at IS NULL AND status = 'created' RETURNING id`, [p.id]);
    if (!mine) continue;
    const out = await send.text(p.mobile,
      `${p.reg_no ? `*${p.reg_no}* — your` : 'Your'} full report is waiting.\n\n`
      + `Pay ₹${Math.round(p.amount_paise / 100)} here (UPI, card, netbanking):\n${base}/pay/${p.checkout_token}\n\n`
      + 'The report arrives in this chat the moment the payment goes through.\n'
      + '🚫 RTO queue · 🚫 Fuel · 🚫 Follow-ups ✨\n\n'
      + '_Reply STOP if you would rather not hear from us._');
    if (out?.ok) { sent += 1; mark(`nudge_pay:${p.id}`, 'whatsapp_reminder_sent', p.mobile, p.user_id, { kind: 'payment', payment_row: p.id }); }
  }
  return sent;
}

async function tick() {
  if (!await settings.bool('nudge_enabled', true)) return { sent: 0 };
  if (!await flags.on('whatsapp_flow')) return { sent: 0 };
  if (quiet(await settings.num('nudge_quiet_from_ist', 21), await settings.num('nudge_quiet_to_ist', 8))) return { sent: 0 };
  const mins = Math.max(15, await settings.num('nudge_after_minutes', 60));
  let sent = await terms(mins);
  sent += await number(mins);
  if (await flags.on('payments')) sent += await payments(mins);
  return { sent };
}

function start(everySeconds = 300) {
  setInterval(require('../util/heartbeat').wrap('nudge', tick, everySeconds), everySeconds * 1000).unref();
}

module.exports = { start, tick, quiet };
