/**
 * src/jobs/waitlist.js — numbers sent while the vehicle records service was
 * down, checked and sent automatically once it is back (user, 2026-10-01).
 * ---------------------------------------------------------------------------
 * Every few minutes: if anyone is waiting, ONE live lookup of the oldest
 * number tests the service. Still down — nothing more is spent, try again next
 * tick. Back — every waiting number gets its free check, in the chat, the way a
 * normal check looks, with one line first saying the service is back.
 *
 * Only inside the customer's 24-hour window, where a reply is free and allowed;
 * a wait that has run past it is marked expired (the admin can still send the
 * Service notice template). Never twice: each row is claimed before it is sent.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const gateway = require('../vehicle/gateway');
const send = require('../whatsapp/send');

const usable = (d) => d && d.success === true && d.rc && (d.rc.maker || d.rc.model || d.rc.vehicle_class);
let running = false;

async function tick() {
  if (running) return { skipped: 'running' };
  running = true;
  try {
    // Past the 24-hour window: can no longer be answered freely.
    await db.query(
      `UPDATE lookup_waitlist w SET status = 'expired', done_at = now(), note = 'reply window closed'
        WHERE w.status = 'waiting' AND NOT EXISTS (
          SELECT 1 FROM whatsapp_sessions s WHERE s.mobile = w.mobile AND s.last_inbound_at > now() - interval '23 hours 50 minutes')`);
    const waiting = (await db.query(
      `SELECT id, mobile, reg_no FROM lookup_waitlist WHERE status = 'waiting' ORDER BY created_at LIMIT 40`)).rows;
    if (!waiting.length) return { waiting: 0 };

    // Is the service back? One live lookup tells.
    const probe = await gateway.full(waiting[0].reg_no, { refresh: 1 }).catch(() => null);
    if (!usable(probe)) return { waiting: waiting.length, back: false };

    console.log(`[waitlist] vehicle records are back — sending ${waiting.length} waiting check(s)`);
    const flow = require('../whatsapp/flow');
    let sent = 0;
    for (const w of waiting) {
      const mine = await db.one(
        `UPDATE lookup_waitlist SET attempts = attempts + 1 WHERE id = $1 AND status = 'waiting' AND attempts < 3 RETURNING id`, [w.id]);
      if (!mine) continue;
      // The lookup itself, before telling them anything: if this one fails, they stay waiting.
      const data = w.id === waiting[0].id ? probe : await gateway.full(w.reg_no).catch(() => null);
      if (!usable(data)) {
        if (data?.error === 'vehicle_not_found') {
          await db.query(`UPDATE lookup_waitlist SET status = 'failed', done_at = now(), note = 'not found' WHERE id = $1`, [w.id]);
        }
        continue;
      }
      try {
        await send.text(w.mobile, `✅ Good news — the Government vehicle records service is back. Here is *${w.reg_no}*, as promised:`);
        await flow.checkFromWaitlist(w.mobile, w.reg_no);
        await db.query(`UPDATE lookup_waitlist SET status = 'delivered', done_at = now() WHERE id = $1`, [w.id]);
        sent += 1;
      } catch (e) {
        console.error('[waitlist] %s: %s', w.reg_no, e.message);
      }
    }
    return { waiting: waiting.length, back: true, sent };
  } finally {
    running = false;
  }
}

function start(everySeconds = 300) {
  setTimeout(() => tick().catch((e) => console.error('[waitlist]', e.message)), 30 * 1000);
  setInterval(() => tick().catch((e) => console.error('[waitlist]', e.message)), everySeconds * 1000);
  console.log(`  waitlist: every ${everySeconds}s`);
}

module.exports = { start, tick };
