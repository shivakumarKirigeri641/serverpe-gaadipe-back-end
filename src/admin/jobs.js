/**
 * src/admin/jobs.js — the Jobs screen (user, 2026-09-25, operations module
 * phase 5).
 * ---------------------------------------------------------------------------
 *   list()             every background job: RUNNING, SUCCESS, FAILED,
 *                      PAUSED or MISSED, last and next run, duration, what it
 *                      processed, runs / failures in 24 hours, last error
 *   runs(name, q)      a job's run history (its log)
 *   runNow(name)       one tick now — the same tick the schedule runs
 *   setPaused(name, p) add to / take off the jobs_paused setting
 *
 * What each job does is written below, so the screen can say it and the
 * confirmation before a manual run can warn what it will send.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const settings = require('../util/settings');
const heartbeat = require('../util/heartbeat');

const ABOUT = {
  watch: ['Vehicle monitoring', 'Re-checks watched vehicles for new challans and RC changes.', false],
  reconcile: ['Payment recovery', 'Finds payments completed at Razorpay whose confirmation was lost, and activates them.', true],
  payment_reconciliation: ['Payment reconciliation', 'Compares the last two days of payments with Razorpay (after 03:00 IST). Changes nothing.', false],
  notify: ['Admin notifications', 'Sends the admin emails and WhatsApp notices that are due.', true],
  customerMail: ['Customer emails', 'Sends customer emails that are due, in the allowed hours.', true],
  referrals: ['Referral processing', 'Referral bookkeeping (the programme is off; the job keeps records tidy).', false],
  expiryWatch: ['Document expiry alerts', 'Warns watchers before insurance, PUC, tax or fitness runs out.', true],
  renewal: ['Renewal reminders', 'Reminds customers before monitoring ends.', true],
  broadcast: ['WhatsApp broadcasts', 'Sends scheduled broadcast messages.', true],
  alerts: ['Alert rules', 'Checks the alert rules and raises or clears alerts.', false],
  maintenance: ['Daily maintenance', 'Scheduled backup (when switched on) and trimming the job history.', false],
};

async function list() {
  const paused = await heartbeat.pausedSet();
  const live = heartbeat.status(paused);
  const { rows: agg } = await db.query(
    `SELECT job, count(*) FILTER (WHERE status IN ('success', 'failed'))::int AS runs_24h,
            count(*) FILTER (WHERE status = 'failed')::int AS failures_24h,
            round(avg(duration_ms) FILTER (WHERE status = 'success'))::int AS avg_ms,
            coalesce(sum(processed), 0)::int AS processed_24h,
            max(started_at) FILTER (WHERE status = 'failed') AS last_failed_at
       FROM job_runs WHERE started_at > now() - interval '24 hours' GROUP BY job`);
  const by = Object.fromEntries(agg.map((a) => [a.job, a]));
  return {
    rows: live.map((j) => ({
      name: j.name, label: ABOUT[j.name]?.[0] || j.name, about: ABOUT[j.name]?.[1] || null, sends: Boolean(ABOUT[j.name]?.[2]),
      status: j.status, every_s: j.every_s, last_run: j.last_start, last_end: j.last_end, next_run: j.paused ? null : j.next_run,
      duration_ms: j.last_ms, processed: j.last_processed, last_error: j.last_error, last_error_at: j.last_error_at,
      runs_since_start: j.runs, ...by[j.name] ? { runs_24h: by[j.name].runs_24h, failures_24h: by[j.name].failures_24h,
        avg_ms: by[j.name].avg_ms, processed_24h: by[j.name].processed_24h } : { runs_24h: 0, failures_24h: 0, avg_ms: null, processed_24h: 0 },
    })),
    notes: { missed: 'MISSED: it has skipped two of its own intervals.', history: 'History is kept for job_runs_keep_days (Settings).' },
  };
}

async function runs(name, q = {}) {
  const limit = Math.min(200, Number(q.limit) || 50); const offset = Math.max(0, Number(q.offset) || 0);
  const args = [String(name)]; let w = 'r.job = $1';
  if (q.status) { args.push(String(q.status)); w += ` AND r.status = $${args.length}`; }
  const { rows } = await db.query(
    `SELECT r.id, r.started_at, r.finished_at, r.duration_ms, r.status, r.processed, r.error, r.trigger, a.name AS admin, count(*) OVER () AS total_rows
       FROM job_runs r LEFT JOIN admin_users a ON a.id = r.admin_id WHERE ${w} ORDER BY r.id DESC LIMIT ${limit} OFFSET ${offset}`, args);
  return { total: rows[0] ? Number(rows[0].total_rows) : 0, rows: rows.map(({ total_rows, ...x }) => ({ ...x, id: String(x.id) })) };
}

async function setPaused(name, paused) {
  if (!heartbeat.status().some((j) => j.name === name)) return { ok: false, message: 'No such job.' };
  const cur = String(await settings.get('jobs_paused', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const next = paused ? [...new Set([...cur, name])] : cur.filter((x) => x !== name);
  await db.query(`INSERT INTO app_settings (key, value) VALUES ('jobs_paused', $1)
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [next.join(',')]);
  if (settings.refresh) await settings.refresh();
  heartbeat.forgetPaused();
  return { ok: true, paused: next, before: cur };
}

module.exports = { list, runs, runNow: heartbeat.runNow, setPaused, ABOUT };
