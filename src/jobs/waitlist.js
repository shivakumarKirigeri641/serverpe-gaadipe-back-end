/**
 * src/jobs/waitlist.js — numbers sent while their RC could not be fetched, answered once it can
 * (user, 2026-10-01; reworked 2026-10-20: "if a user has any vehicle that was told 'server is busy',
 * can the bot reply with the fetched details when the RC fetch is successful?").
 * ---------------------------------------------------------------------------
 * WHY IT WAS STUCK: it asked ULIP every few minutes "are you back?", and served nobody until ULIP
 * answered. ULIP's VAHAN answers yellow-plate (commercial) vehicles only — for a private vehicle it
 * never comes back. The RC now comes from ULIP, then eChallan.app, then IDSPay (migration 195), so
 * each waiting number is simply looked up again on its own.
 *
 * TWO WAYS A WAITING NUMBER IS ANSWERED
 *   tick()            every few minutes: anyone still inside their 24-hour WhatsApp window (a reply
 *                     there is free and allowed; send.windowOpen, which counts only messages to the
 *                     current number) gets the details now. At most PER_TICK lookups a pass.
 *   onReturn(mobile)  whenever the person writes to GaadiPe again (routes/whatsapp.js, after the bot
 *                     has answered what they wrote): any number they were told "busy" about in the
 *                     last RETURN_DAYS is looked up and sent — the reply is free, nothing is pushed
 *                     to someone who did not write. Waits past the window are 'expired' but still
 *                     answered this way.
 * Never twice: each row is claimed before it is looked up; a lookup that fails leaves it waiting.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const gateway = require('../vehicle/gateway');
const send = require('../whatsapp/send');

const usable = (d) => d && d.success === true && d.rc && (d.rc.maker || d.rc.model || d.rc.vehicle_class);
const PER_TICK = 10;
const RETURN_DAYS = 45;
let running = false;

/** Look one waiting row up and, when the RC is there, send it in the chat. true when delivered. */
async function deliver(w, intro) {
  const mine = await db.one(
    `UPDATE lookup_waitlist SET attempts = attempts + 1
      WHERE id = $1 AND status IN ('waiting', 'expired') AND attempts < 5 RETURNING id`, [w.id]);
  if (!mine) return false;
  // The full chain (ULIP, eChallan.app, IDSPay) — the same as any free check now.
  const data = await gateway.full(w.reg_no, await require('../vehicle/rcBackup').freeOpts()).catch(() => null);
  if (!usable(data)) {
    if (data?.error === 'vehicle_not_found') {
      await db.query(`UPDATE lookup_waitlist SET status = 'failed', done_at = now(), note = 'not found' WHERE id = $1`, [w.id]);
    }
    return false;
  }
  await send.text(w.mobile, intro);
  await require('../whatsapp/flow').checkFromWaitlist(w.mobile, w.reg_no);
  await db.query(`UPDATE lookup_waitlist SET status = 'delivered', done_at = now() WHERE id = $1`, [w.id]);
  return true;
}

async function tick() {
  if (running) return { skipped: 'running' };
  // The waiting list answers on WhatsApp only: no pass while WhatsApp is off (2026-10-20, send.live).
  if (!(await send.live().catch(() => false))) return { skipped: 'whatsapp_off' };
  running = true;
  try {
    const waiting = (await db.query(
      `SELECT id, mobile, reg_no FROM lookup_waitlist WHERE status = 'waiting' ORDER BY created_at LIMIT 60`)).rows;
    if (!waiting.length) return { waiting: 0 };
    let sent = 0; let looked = 0; let closed = 0;
    for (const w of waiting) {
      // Past the 24-hour window: kept for when they write again (onReturn), not pushed now.
      if (!(await send.windowOpen(w.mobile).catch(() => false))) {
        await db.query(`UPDATE lookup_waitlist SET status = 'expired', note = 'reply window closed — answered when they write again'
                         WHERE id = $1 AND status = 'waiting'`, [w.id]);
        closed += 1;
        continue;
      }
      if (looked >= PER_TICK) continue;
      looked += 1;
      try {
        if (await deliver(w, `📋 Here are the details of *${w.reg_no}*, as promised:`)) sent += 1;
      } catch (e) {
        console.error('[waitlist] %s: %s', w.reg_no, e.message);
      }
    }
    if (sent || closed) console.log('[waitlist] delivered %d, %d moved to "when they write again"', sent, closed);
    return { waiting: waiting.length, sent, closed };
  } finally {
    running = false;
  }
}

/**
 * They wrote to GaadiPe again: answer what they were told "busy" about. Called after the bot has
 * handled their message (routes/whatsapp.js). At most 3 numbers, oldest first. Never throws.
 */
async function onReturn(mobile) {
  try {
    if (!(await send.live().catch(() => false))) return 0;
    if (await send.optedOut(mobile).catch(() => true)) return 0;
    // A number they have just sent again was answered by the bot itself: closed, not sent twice.
    await db.query(
      `UPDATE lookup_waitlist w SET status = 'delivered', done_at = now(), note = 'they sent it again'
        WHERE w.mobile = $1 AND w.status IN ('waiting', 'expired')
          AND EXISTS (SELECT 1 FROM whatsapp_messages m
                       WHERE m.mobile = w.mobile AND m.direction = 'in' AND m.created_at > now() - interval '10 minutes'
                         AND upper(regexp_replace(coalesce(m.body, ''), '[^A-Za-z0-9]', '', 'g')) LIKE '%' || w.reg_no || '%')`,
      [mobile]);
    const rows = (await db.query(
      `SELECT id, mobile, reg_no FROM lookup_waitlist
        WHERE mobile = $1 AND status IN ('waiting', 'expired') AND attempts < 5
          AND created_at > now() - make_interval(days => $2)
        ORDER BY created_at LIMIT 3`, [mobile, RETURN_DAYS])).rows;
    let sent = 0;
    for (const w of rows) {
      if (await deliver(w, `📋 Earlier you asked about *${w.reg_no}* — here are its details:`).catch((e) => {
        console.error('[waitlist] on return %s: %s', w.reg_no, e.message); return false;
      })) sent += 1;
    }
    if (sent) console.log('[waitlist] %s wrote again — %d earlier number(s) answered', String(mobile).slice(-4), sent);
    return sent;
  } catch (e) {
    console.error('[waitlist] on return:', e.message);
    return 0;
  }
}

function start(everySeconds = 300) {
  setTimeout(() => tick().catch((e) => console.error('[waitlist]', e.message)), 30 * 1000);
  setInterval(() => tick().catch((e) => console.error('[waitlist]', e.message)), everySeconds * 1000);
  console.log(`  waitlist: every ${everySeconds}s`);
}

module.exports = { start, tick, onReturn };
