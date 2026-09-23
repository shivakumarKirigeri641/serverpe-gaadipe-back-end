/**
 * src/jobs/broadcast.js — sending a queued WhatsApp broadcast (user, 2026-09-23).
 *
 * A few messages a minute (whatsapp_broadcast_per_tick, 5), never a blast. A
 * new WhatsApp number is rated on how people react to it, and a hundred
 * template messages in one second is the shape of a number about to be
 * restricted — slow is not a limitation here, it is the point.
 *
 * Each target is claimed by raising its attempt count before the send, so a
 * tick that overlaps the previous one cannot message the same person twice.
 * A failed send is retried on a later tick, up to three times; "not allowed"
 * (WHATSAPP_ALLOWED_RECEPIENTS) and "blocked" are not failures to retry, they
 * are decisions, and are recorded as skipped.
 */

const db = require('../db');
const settings = require('../util/settings');
const send = require('../whatsapp/send');
const { config } = require('../config');

const MAX_ATTEMPTS = 3;
/** Refusals from the door in send.js: a decision, not a fault to retry. */
const DECIDED = new Set(['recipient_not_allowed', 'blocked']);

async function runOnce() {
  if (!config.whatsapp.enabled) return { off: true };
  const perTick = Math.max(1, await settings.num('whatsapp_broadcast_per_tick', 5));

  const { rows } = await db.query(
    `SELECT t.id, t.mobile, t.params, t.attempts, b.template_name, b.language
       FROM whatsapp_broadcast_targets t
       JOIN whatsapp_broadcasts b ON b.id = t.broadcast_id
      WHERE b.status = 'queued' AND t.status IN ('pending', 'failed') AND t.attempts < ${MAX_ATTEMPTS}
      ORDER BY t.id LIMIT $1`, [perTick]);

  let sent = 0;
  for (const t of rows) {
    // Claimed before sending: an overlapping tick cannot pick this one up again.
    await db.query(`UPDATE whatsapp_broadcast_targets SET attempts = attempts + 1 WHERE id = $1`, [t.id]);
    const out = await send.template(t.mobile, t.template_name, t.params || [], { language: t.language });
    const status = out.ok ? 'sent' : DECIDED.has(out.error) ? 'skipped' : 'failed';
    await db.query(
      `UPDATE whatsapp_broadcast_targets
          SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() END
        WHERE id = $1`,
      [t.id, status, out.ok ? null : String(out.error || '').slice(0, 500)]);
    if (out.ok) sent += 1;
  }

  // A broadcast with nothing left to send is finished.
  await db.query(
    `UPDATE whatsapp_broadcasts b SET status = 'sent', finished_at = now()
      WHERE b.status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM whatsapp_broadcast_targets t
                         WHERE t.broadcast_id = b.id
                           AND t.status IN ('pending', 'failed') AND t.attempts < ${MAX_ATTEMPTS})`);

  if (sent) console.log('[broadcast] sent %d template message(s)', sent);
  return { sent, looked_at: rows.length };
}

function start(everySeconds = 60) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runOnce(); } catch (e) { console.error('[broadcast] pass failed:', e.message); }
    finally { running = false; }
  };
  setInterval(tick, everySeconds * 1000).unref();
  setTimeout(tick, 8000).unref();
  console.log(`  whatsapp broadcast job: every ${everySeconds}s`);
}

module.exports = { start, runOnce };
