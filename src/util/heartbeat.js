/**
 * src/util/heartbeat.js — did each background job actually run? (user,
 * 2026-09-25, command center phase 6; history, pause and run-now added in the
 * operations module, phase 5).
 *
 * A job that silently stops is the failure nobody notices until a customer
 * does: payments stop being reconciled, alerts stop going out. Each job's tick
 * is wrapped here, so the System health and Jobs screens and the alert checker
 * can see when every job last started and finished, how long it took, how much
 * it did, and its last error — and call a job "missed" when it has skipped two
 * of its own intervals.
 *
 * Now in memory (this process) AND in job_runs (every run, kept
 * job_runs_keep_days), so a restart no longer wipes the history. Writing the
 * history never delays or breaks the job: it is fire-and-forget.
 *
 * A job named in the setting jobs_paused skips its ticks (recorded as
 * "paused") until it is taken off the list. runNow() runs one tick at once —
 * the same tick the schedule would run a little later.
 */

const jobs = new Map();
const ticks = new Map();

let pausedCache = { at: 0, set: new Set() };
async function pausedSet() {
  if (Date.now() - pausedCache.at < 15000) return pausedCache.set;
  try {
    const v = String(await require('./settings').get('jobs_paused', '') || '');
    pausedCache = { at: Date.now(), set: new Set(v.split(',').map((s) => s.trim()).filter(Boolean)) };
  } catch { pausedCache.at = Date.now(); }
  return pausedCache.set;
}
const forgetPaused = () => { pausedCache.at = 0; };

/* How much a tick did, if it said: a number, or a count in what it returned. */
function processedOf(out) {
  if (typeof out === 'number' && Number.isFinite(out)) return Math.round(out);
  if (out && typeof out === 'object') {
    for (const k of ['processed', 'sent', 'checked', 'recovered', 'count', 'delivered', 'raised']) {
      if (Number.isFinite(Number(out[k]))) return Math.round(Number(out[k]));
    }
  }
  return null;
}

/* Record a run; never throws, never waits. */
function record(fields) {
  try {
    const db = require('../db');
    return db.one(
      `INSERT INTO job_runs (job, started_at, finished_at, duration_ms, status, processed, error, trigger, admin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [fields.job, fields.started_at, fields.finished_at || null, fields.duration_ms ?? null, fields.status,
       fields.processed ?? null, fields.error || null, fields.trigger || 'schedule', fields.admin_id || null])
      .catch(() => null);
  } catch { return Promise.resolve(null); }
}

/** Wrap a job's tick; `everySeconds` is how often it is meant to run. */
function wrap(name, tick, everySeconds) {
  const j = jobs.get(name) || { name, every_s: everySeconds, registered_at: new Date(), runs: 0, failures: 0,
                                last_start: null, last_end: null, last_ms: null, last_error: null, last_error_at: null,
                                last_processed: null, running: false, last_trigger: null };
  j.every_s = everySeconds;
  jobs.set(name, j);
  const run = async ({ trigger = 'schedule', adminId = null } = {}, ...args) => {
    if (trigger === 'schedule' && (await pausedSet()).has(name)) {
      j.paused = true;
      // Once every ten minutes is enough to show it was paused, not every tick.
      if (!j.paused_logged_at || Date.now() - j.paused_logged_at > 10 * 60000) {
        j.paused_logged_at = Date.now();
        record({ job: name, started_at: new Date(), finished_at: new Date(), duration_ms: 0, status: 'paused' });
      }
      return undefined;
    }
    j.paused = false;
    j.last_start = new Date(); j.running = true; j.last_trigger = trigger;
    let status = 'success'; let error = null; let out;
    try {
      out = await tick(...args);
      return out;
    } catch (e) {
      status = 'failed';
      error = String(e?.message || e).slice(0, 300);
      j.last_error = error; j.last_error_at = new Date(); j.failures += 1;
      throw e;
    } finally {
      j.last_end = new Date(); j.running = false;
      j.last_ms = j.last_end - j.last_start;
      j.runs += 1;
      j.last_processed = processedOf(out);
      record({ job: name, started_at: j.last_start, finished_at: j.last_end, duration_ms: j.last_ms, status,
               processed: j.last_processed, error, trigger, admin_id: adminId });
    }
  };
  ticks.set(name, run);
  // The scheduler calls the wrapper with the tick's own arguments.
  return (...args) => run({ trigger: 'schedule' }, ...args);
}

/** Run one job's tick now (the Jobs screen). */
async function runNow(name, adminId) {
  const run = ticks.get(name);
  if (!run) return { ok: false, message: 'No such job in this process.' };
  const j = jobs.get(name);
  if (j?.running) return { ok: false, message: 'That job is running right now.' };
  try {
    await run({ trigger: 'manual', adminId });
    return { ok: true, processed: j.last_processed, ms: j.last_ms };
  } catch (e) {
    return { ok: false, message: String(e?.message || e).slice(0, 300) };
  }
}

/** Every job, with whether it is on time. */
function status(paused = pausedCache.set) {
  const now = Date.now();
  return [...jobs.values()].map((j) => {
    const since = j.last_end ? (now - j.last_end) / 1000 : (now - j.registered_at) / 1000;
    // Missed after skipping two of its own intervals (and at least 3 minutes).
    const late = since > Math.max(180, j.every_s * 2 + 60);
    const isPaused = paused.has(j.name);
    const lastFailed = j.last_error_at && (!j.last_end || j.last_error_at >= j.last_end - 1000);
    return {
      ...j, seconds_since: Math.round(since), late: late && !isPaused, paused: isPaused,
      next_run: j.last_start ? new Date(j.last_start.getTime() + j.every_s * 1000) : null,
      state: late && !isPaused ? 'late' : lastFailed ? 'error' : j.runs ? 'ok' : 'waiting',
      // The Jobs screen's words.
      status: j.running ? 'RUNNING' : isPaused ? 'PAUSED' : late ? 'MISSED' : lastFailed ? 'FAILED' : j.runs ? 'SUCCESS' : 'WAITING',
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { wrap, status, runNow, pausedSet, forgetPaused, processedOf };
