/**
 * src/jobs/maintenance.js — once a day (user, 2026-09-25, operations module
 * phase 5): the scheduled database backup, when backup_scheduled_enabled is
 * on, at backup_hour_ist; and trimming job_runs to job_runs_keep_days.
 */

const db = require('../db');
const settings = require('../util/settings');

async function tick() {
  const hour = new Date(Date.now() + 330 * 60000).getUTCHours();
  let processed = 0;
  // History older than the keep window goes, every tick (cheap, indexed).
  const keep = await settings.num('job_runs_keep_days', 7);
  const del = await db.query(`DELETE FROM job_runs WHERE started_at < now() - ($1 || ' days')::interval`, [String(keep)]);
  processed += del.rowCount;
  if (await settings.bool('backup_scheduled_enabled', false) && hour >= await settings.num('backup_hour_ist', 2)) {
    const done = await db.one(`SELECT 1 AS ok FROM backups WHERE trigger = 'schedule' AND status IN ('success', 'running', 'deleted')
                                 AND started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' LIMIT 1`);
    if (!done) {
      const out = await require('../admin/backups').runScheduled({ trigger: 'schedule' });
      if (!out.ok && !out.skipped) throw new Error(`Backup failed: ${out.message}`);
      processed += 1;
    }
  }
  return { processed };
}

function start(everySeconds = 3600) {
  setInterval(require('../util/heartbeat').wrap('maintenance', tick, everySeconds), everySeconds * 1000).unref();
}

module.exports = { start, tick };
