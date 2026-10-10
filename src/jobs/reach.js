/**
 * src/jobs/reach.js — sending what the web admin queued (user, 2026-10-10: "SMS to
 * specific users from the admin panel"; migration 155).
 *
 * Each due row of notify_queue is claimed (status 'sending') before it is sent, so
 * two passes can never send it twice, and a pass never overlaps the one before.
 * A few at a time (reach_sms_per_tick 20, reach_push_per_tick 50). SMS goes through
 * util/sms.sendTemplate — the approved template, the blocks, the 9 am – 9 pm rule
 * for offers — and notifications through site/push.toCustomer. Both write
 * notify_log themselves, with this queue row's id.
 */

const db = require('../db');
const settings = require('../util/settings');

async function runOnce() {
  const smsN = Math.max(1, await settings.num('reach_sms_per_tick', 20));
  const pushN = Math.max(1, await settings.num('reach_push_per_tick', 50));
  let done = 0;
  for (const [channel, n] of [['sms', smsN], ['push', pushN]]) {
    const { rows } = await db.query(
      `UPDATE notify_queue SET status = 'sending'
        WHERE id IN (SELECT id FROM notify_queue WHERE channel = $1 AND status = 'queued' AND send_at <= now()
                      ORDER BY send_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [channel, n]);
    for (const q of rows) {
      let status = 'failed';
      let result = null;
      try {
        if (channel === 'sms') {
          const out = await require('../util/sms').sendTemplate(q.kind, q.mobile, Array.isArray(q.vals) ? q.vals : [],
            { queueId: q.id, adminId: q.admin_id });
          status = out.simulated || out.ok ? 'sent' : out.skipped ? 'skipped' : 'failed';
          result = out.simulated ? 'simulated (no SMS provider here)' : out.ok ? null : out.error || null;
        } else {
          const sent = await require('../site/push').toCustomer(q.user_id, {
            title: q.title, body: q.body, url: q.url || '/chat', tag: `manual-${q.id}`, kind: q.kind || 'manual',
            queueId: q.id, adminId: q.admin_id });
          status = sent > 0 ? 'sent' : 'skipped';
          result = sent > 0 ? `${sent} device${sent === 1 ? '' : 's'}` : 'no notification device';
        }
      } catch (e) { result = e.message; }
      await db.query(`UPDATE notify_queue SET status = $2, result = $3, sent_at = now() WHERE id = $1`, [q.id, status, result]);
      done += 1;
    }
  }
  // A row left 'sending' by a crash goes back to the queue after ten minutes.
  await db.query(`UPDATE notify_queue SET status = 'queued' WHERE status = 'sending' AND sent_at IS NULL AND send_at < now() - interval '10 minutes'`);
  return { done };
}

function start(everySeconds = 60) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runOnce(); } catch (e) { console.error('[reach] pass failed:', e.message); }
    finally { running = false; }
  };
  setInterval(require('../util/heartbeat').wrap('reach', tick, everySeconds), everySeconds * 1000).unref();
  setTimeout(tick, 9000).unref();
  console.log(`  SMS & notification queue: every ${everySeconds}s`);
}

module.exports = { start, runOnce };
