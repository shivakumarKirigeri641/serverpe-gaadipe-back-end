/**
 * src/jobs/referrals.js — the QuizPe referral check on a timer (user, 2026-09-21).
 *
 * Every referral_check_minutes (10): expire old referrals (their numbers are
 * deleted), and ask QuizPe — read-only — whether any pending referral's parent
 * has bought premium. See referrals/quizpe.js. Never overlaps itself.
 */

const settings = require('../util/settings');
const referrals = require('../referrals/quizpe');

function start() {
  let running = false;
  let last = 0;
  const tick = async () => {
    if (running) return;
    const every = Math.max(1, await settings.num('referral_check_minutes', 10).catch(() => 10));
    if (Date.now() - last < every * 60 * 1000) return;
    running = true; last = Date.now();
    try { await referrals.check(); } catch (e) { console.error('[referrals] pass failed:', e.message); }
    finally { running = false; }
  };
  setInterval(tick, 60 * 1000).unref();
  setTimeout(tick, 15000).unref();
  console.log('  referral check: every few minutes (QuizPe read-only %s)',
    require('../quizpe/readonly').configured() ? 'configured' : 'NOT configured — referrals wait');
}

module.exports = { start };
