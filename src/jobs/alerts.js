/**
 * src/jobs/alerts.js — run the alert rules every minute (user, 2026-09-25,
 * command center phase 6). The rules live in src/admin/alerts.js; this only
 * keeps time, and records its own heartbeat like every other job.
 */

const alerts = require('../admin/alerts');

function start(everySeconds = 60) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await alerts.check(); } catch (e) { console.error('[alerts] check failed:', e.message); } finally { running = false; }
  };
  setInterval(require('../util/heartbeat').wrap('alerts', tick, everySeconds), everySeconds * 1000).unref();
  setTimeout(tick, 20 * 1000).unref();
  console.log(`  alert checks: every ${everySeconds}s`);
}

module.exports = { start };
