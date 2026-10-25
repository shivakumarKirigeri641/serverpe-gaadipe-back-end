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

/* NEVER A BURST (user, 2026-10-25: the first run after the deploy sent ~15 identical reminders in seconds -
   "please have some gap, otherwise this triggers a ban"). At most nudge_per_tick reminders a run (2, a run
   every 5 minutes) with a random 30-90 s gap between them; the Hi reminder also only for a Hi in the last
   nudge_hi_window_hours (3), so a backlog of old ones is never swept up in one go. */
const PER_TICK = 20;
const perTick = async () => Math.max(1, Math.min(PER_TICK, await settings.num('nudge_per_tick', 2)));
const gap = () => new Promise((r) => setTimeout(r, 30000 + Math.floor(Math.random() * 60000)));
const SITE = process.env.PUBLIC_SITE_URL || 'https://gaadipe.in';   // as flow.js links the policies
const SITE_BASE = () => (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

function quiet(from, to) {
  const h = new Date(Date.now() + 330 * 60000).getUTCHours();
  return from > to ? h >= from || h < to : h >= from && h < to;
}

function mark(key, name, mobile, userId, meta) {
  require('../events/track').fire({ key, name, channel: 'whatsapp', mobile, userId: userId || null, status: 'ok', meta });
}

async function terms(mins, windowHours = 23) {
  const due = (await db.query(
    `SELECT id, mobile, user_id FROM whatsapp_sessions
      WHERE state = 'owner_consent' AND terms_nudged_at IS NULL AND wa_opt_out_at IS NULL
        AND modified_at     <= now() - make_interval(mins => $1)
        AND last_inbound_at <= now() - make_interval(mins => $1)
        AND last_inbound_at >  now() - make_interval(hours => $2)
        AND ${NOT_HUSHED('whatsapp_sessions')}
      ORDER BY last_inbound_at DESC LIMIT ${await perTick()}`, [mins, Math.min(23, windowHours)])).rows;
  let sent = 0;
  for (const s of due) {
    if (sent) await gap();
    // Claim first: whoever gets the row sends; a reply that moved them on
    // since the SELECT means no reminder at all.
    const mine = await db.one(
      `UPDATE whatsapp_sessions SET terms_nudged_at = now()
        WHERE id = $1 AND terms_nudged_at IS NULL AND state = 'owner_consent'
          AND last_inbound_at <= now() - make_interval(mins => $2)
      RETURNING id`, [s.id, mins]);
    if (!mine) continue;
    // A new person agrees by sending a number (flow.js NEW_TERMS, 2026-10-25); someone asked again after a Terms update taps.
    const out = !(await send.agreedTerms(s.mobile)) ? await send.text(s.mobile,
      'Still want to check your vehicle? 🙂\n\n'
      + 'Just send its number, like *KA01AB1234* — you will see its insurance, PUC, tax and challan status in seconds.\n\n'
      + `_By typing and sending a vehicle number, you agree to our Terms, Privacy & Refund policies (${SITE}/terms)._`)
      : await send.buttons(s.mobile,
      'Still want to check your vehicle? 🙂\n\n'
      + 'Tap *Agree & continue* below, then send your vehicle number (like KA01XX1234).'
      + 'You will see its insurance, PUC, tax and challan status in seconds.\n\n'
      // What the button agrees to, in the same message as the button (user,
      // 2026-09-28) — not only in the terms screen further up the chat.
      + `By agreeing you accept our Terms (${SITE}/terms), Privacy (${SITE}/privacy) and Refund (${SITE}/refund) policies.`,
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
      ORDER BY last_inbound_at LIMIT ${await perTick()}`, [mins])).rows;
  let sent = 0;
  for (const s of due) {
    if (sent) await gap();
    const mine = await db.one(
      `UPDATE whatsapp_sessions SET number_nudged_at = now()
        WHERE id = $1 AND number_nudged_at IS NULL AND state = 'owner_start'
          AND last_inbound_at <= now() - make_interval(mins => $2)
      RETURNING id`, [s.id, mins]);
    if (!mine) continue;
    const out = await send.text(s.mobile,
      'Ready when you are 🙂\n\n'
      + 'Just send your vehicle number here — like *KA01XX1234* — and I will show its '
      + 'insurance, PUC, tax and challan status in seconds.');
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
        -- and at most ONE payment reminder per person a day, whatever they tap (user, 2026-10-25): the number's
        -- quality matters more than one more sale, and a second reminder the same day reads as pushy.
        AND NOT EXISTS (SELECT 1 FROM payments r WHERE r.user_id = p.user_id AND r.nudged_at > now() - interval '24 hours')
      ORDER BY p.created_at LIMIT ${await perTick()}`, [mins])).rows;
  let sent = 0;
  for (const p of due) {
    if (sent) await gap();
    const mine = await db.one(
      `UPDATE payments SET nudged_at = now() WHERE id = $1 AND nudged_at IS NULL AND status = 'created' RETURNING id`, [p.id]);
    if (!mine) continue;
    /* One gentle reminder with THREE REPLY BUTTONS (user, 2026-10-25: "so that reply quality increases") - Pay,
       Check another, Not now. A tap is a reply Meta counts in the number's favour, and "Not now" is an easy way
       out instead of Block. Pay sends this order's secure Pay button again (flow.js payReminderTap). No bare
       link: that is the e-challan scam's pattern. */
    const rupees = Math.round(p.amount_paise / 100);
    const body = `${p.reg_no ? `Your full report for *${p.reg_no}*` : 'Your full report'} is ready to unlock — *₹${rupees}*.\n\n`
      + '✅ UPI (GPay, PhonePe, Paytm), card or netbanking · secure checkout by Razorpay\n'
      + '✅ It arrives in this chat the moment you pay\n\n'
      + '_No reminder after this one._';
    let out = await send.buttons(p.mobile, body, [
      { id: `pay|p|${p.id}`, title: `Pay ₹${rupees}` },
      { id: `pay|c|${p.id}`, title: 'Check another' },
      { id: `pay|n|${p.id}`, title: 'Not now' },
    ], { footer: 'GaadiPe · secure checkout by Razorpay' }).catch(() => ({ ok: false }));
    if (!out?.ok) out = await send.text(p.mobile, `${body}\n\n${base}/pay/${p.checkout_token}`);
    if (out?.ok) { sent += 1; mark(`nudge_pay:${p.id}`, 'whatsapp_reminder_sent', p.mobile, p.user_id, { kind: 'payment', payment_row: p.id }); }
  }
  return sent;
}

async function tick() {
  /* THE PAYMENT REMINDER HAS ITS OWN SWITCH (user, 2026-10-25: 3 of 4 who tapped buy never opened the link).
     nudge_enabled (off since 2026-10-09) still governs the Terms and number reminders; nudge_payment_enabled
     (on) lets the one reminder about an unpaid link go - to someone who asked for it, inside their window. */
  /* SAID HI, THEN QUIET (user, 2026-10-25: 29 said Hi, 14 never sent a vehicle number). The terms reminder -
     "just send its number" - has its own switch too: nudge_hi_enabled (on), after nudge_hi_after_minutes (30).
     Once per person, inside their window, never at night or after STOP. */
  const all = await settings.bool('nudge_enabled', true);
  const pay = await settings.bool('nudge_payment_enabled', true);
  const hi = await settings.bool('nudge_hi_enabled', true);
  if (!all && !pay && !hi) return { sent: 0 };
  if (!await flags.on('whatsapp_flow')) return { sent: 0 };
  if (quiet(await settings.num('nudge_quiet_from_ist', 21), await settings.num('nudge_quiet_to_ist', 8))) return { sent: 0 };
  const mins = Math.max(15, await settings.num('nudge_after_minutes', 60));
  let sent = 0;
  if (all || hi) {
    sent += all ? await terms(mins)
      : await terms(Math.max(15, await settings.num('nudge_hi_after_minutes', 30)), await settings.num('nudge_hi_window_hours', 3));
  }
  if (all) sent += await number(mins);
  if (pay && await flags.on('payments')) sent += await payments(mins);
  return { sent };
}

function start(everySeconds = 300) {
  setInterval(require('../util/heartbeat').wrap('nudge', tick, everySeconds), everySeconds * 1000).unref();
}

module.exports = { start, tick, quiet };
