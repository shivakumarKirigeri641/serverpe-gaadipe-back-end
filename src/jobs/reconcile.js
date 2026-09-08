/**
 * src/jobs/reconcile.js
 * ---------------------------------------------------------------------------
 * Catch the payments the webhook missed.
 *
 * WHY THIS EXISTS, CONCRETELY: a real Rs.59 test payment was captured by
 * Razorpay and the webhook never arrived — wrong URL, dead tunnel, a delivery
 * that failed while the server was restarting. The money was taken and the
 * customer got nothing. There is no worse failure in this product.
 *
 * A webhook is a delivery attempt, not a guarantee. So every payment we asked
 * for but never saw completed is checked against Razorpay directly, and
 * activated from the same code path the webhook uses. Belt and braces, where
 * the braces are the ones the customer actually feels.
 *
 * Cheap: only rows still 'created' are examined, and only those old enough that
 * a webhook would already have arrived if it were coming.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const rzp = require('../pay/razorpay');
const billing = require('../pay/billing');

/**
 * Payments we asked for, never saw completed, and are old enough to be
 * suspicious. Anything past the link's own expiry is left alone — an unpaid
 * link is a customer who changed their mind, not a problem.
 *
 * 45 seconds, not minutes: a webhook that is coming arrives within a second or
 * two, so anything older than that is already late. The first version waited
 * two minutes and ran every five, which meant a real payment could sit
 * unacknowledged for seven — an eternity for someone staring at their phone
 * having just paid.
 */
async function pending({ olderThanSeconds = 45, withinHours = 48 } = {}) {
  const { rows } = await db.query(
    `SELECT id, order_id, raw
       FROM payments
      WHERE status = 'created'
        AND gateway = 'razorpay'
        AND created_at < now() - ($1 || ' seconds')::interval
        AND created_at > now() - ($2 || ' hours')::interval
      ORDER BY created_at
      LIMIT 25`, [String(olderThanSeconds), String(withinHours)]);
  return rows;
}

async function runOnce() {
  if (!rzp.configured()) return { checked: 0, recovered: 0 };

  const rows = await pending();
  let recovered = 0;

  for (const row of rows) {
    const linkId = row.raw?.link_id || row.order_id;
    if (!linkId || !String(linkId).startsWith('plink_')) continue;

    let link;
    try {
      link = await rzp.getLink(linkId);
    } catch (e) {
      console.warn('[reconcile] could not read %s: %s', linkId, e.message);
      continue;
    }

    if (link.status !== 'paid') continue;

    const payment = (link.payments || []).find(p => p.status === 'captured');
    const result = await billing.activate({
      paymentRowId: row.id,
      razorpayPaymentId: payment?.payment_id || link.id,
      orderId: link.order_id || link.id,
      raw: link,
    });

    if (result.activated) {
      recovered++;
      console.log('[reconcile] RECOVERED payment %d (%s) — the webhook never arrived',
        row.id, linkId);
      // Told from here, exactly as the webhook path tells them, so a recovered
      // customer's experience is identical to a normal one.
      const { notifyPaid } = require('../routes/payments');
      await notifyPaid(result).catch(e => console.error('[reconcile] notify:', e.message));
    }
  }

  if (rows.length) {
    console.log('[reconcile] checked %d pending payment(s), recovered %d', rows.length, recovered);
  }
  return { checked: rows.length, recovered };
}

/**
 * Start the loop.
 *
 * Every minute. The webhook is still the fast path — this only ever acts when
 * that path failed, and a minute is short enough that a customer reads it as
 * "it took a moment" rather than "nothing happened".
 */
function start(everySeconds = 60) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runOnce(); } catch (e) { console.error('[reconcile] pass failed:', e.message); }
    finally { running = false; }
  };
  setInterval(tick, everySeconds * 1000).unref();
  setTimeout(tick, 10000).unref();
  console.log(`  payment reconciler: every ${everySeconds}s`);
}

module.exports = { start, runOnce, pending };
