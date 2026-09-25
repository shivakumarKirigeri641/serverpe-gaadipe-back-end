/**
 * src/util/heartbeat.js — did each background job actually run? (user,
 * 2026-09-25, command center phase 6).
 *
 * A job that silently stops is the failure nobody notices until a customer
 * does: payments stop being reconciled, alerts stop going out. Each job's tick
 * is wrapped here, so the System health screen and the alert checker can see
 * when every job last started and finished, how long it took, and its last
 * error — and call a job "late" when it has missed two of its own intervals.
 *
 * In memory, on purpose: it describes this process. A restart shows every job
 * as "not run yet" until its first tick, which is the truth.
 */

const jobs = new Map();

/** Wrap a job's tick; `everySeconds` is how often it is meant to run. */
function wrap(name, tick, everySeconds) {
  const j = jobs.get(name) || { name, every_s: everySeconds, registered_at: new Date(), runs: 0,
                                last_start: null, last_end: null, last_ms: null, last_error: null, last_error_at: null };
  j.every_s = everySeconds;
  jobs.set(name, j);
  return async (...args) => {
    j.last_start = new Date();
    try {
      return await tick(...args);
    } catch (e) {
      j.last_error = String(e?.message || e).slice(0, 300);
      j.last_error_at = new Date();
      throw e;
    } finally {
      j.last_end = new Date();
      j.last_ms = j.last_end - j.last_start;
      j.runs += 1;
    }
  };
}

/** Every job, with whether it is on time. */
function status() {
  const now = Date.now();
  return [...jobs.values()].map((j) => {
    const since = j.last_end ? (now - j.last_end) / 1000 : (now - j.registered_at) / 1000;
    // Late after missing two of its own intervals (and at least 3 minutes).
    const late = since > Math.max(180, j.every_s * 2 + 60);
    return { ...j, seconds_since: Math.round(since), late,
             state: late ? 'late' : j.last_error_at && (!j.last_end || j.last_error_at >= j.last_end - 1000) ? 'error' : j.runs ? 'ok' : 'waiting' };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { wrap, status };
