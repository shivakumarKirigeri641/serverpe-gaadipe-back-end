/**
 * src/jobs/analyticsRollup.js — keeps analytics_minute current (migration 127).
 *
 * Every minute: the last five minutes are written again (events that arrive a
 * little late are counted). At start: the last two days are filled in, so the
 * charts have history straight after a deploy. Hourly: rows older than
 * analytics_minute_retention_days are deleted. Reads only; never in a
 * customer's way.
 */
const analytics = require('../admin/analytics');

function start(everySeconds = 60) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await analytics.rollup(new Date(Date.now() - 5 * 60000), new Date(Date.now() + 60000)); }
    catch (e) { console.error('[analytics] rollup: %s', e.message); }
    finally { running = false; }
  };
  setTimeout(async () => {
    running = true;
    try {
      // Two days, an hour at a time, so no single query is large.
      for (let h = 48; h > 0; h -= 1) await analytics.rollup(new Date(Date.now() - h * 3600e3), new Date(Date.now() - (h - 1) * 3600e3));
      console.log('[analytics] the last 48 hours are rolled up');
    } catch (e) { console.error('[analytics] backfill: %s', e.message); }
    finally { running = false; }
  }, 20 * 1000).unref();
  setInterval(tick, everySeconds * 1000).unref();
  setInterval(() => analytics.prune().catch((e) => console.error('[analytics] prune: %s', e.message)), 3600e3).unref();
  console.log(`  analytics rollup: every ${everySeconds}s`);
}

module.exports = { start };
