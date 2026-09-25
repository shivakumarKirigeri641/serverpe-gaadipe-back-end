/**
 * src/admin/backups.js — Backup & Recovery (user, 2026-09-25, operations
 * module phase 5).
 * ---------------------------------------------------------------------------
 *   status()   the last backup of either kind — the owner's download from the
 *              panel (admin_audit: database_downloaded) or a scheduled backup
 *              written on this server — its age and size, the history,
 *              retention, and the database's own health
 *   runScheduled({trigger, adminId})
 *              pg_dump into BACKUP_DIR (custom format), then delete files
 *              older than backup_retention_days. Only while
 *              backup_scheduled_enabled is on: by default GaadiPe leaves no
 *              copy of its data on the server (src/admin/backup.js).
 *
 * There is no restore here. Restoring replaces the live database and is done
 * by a person on the server with pg_restore — never from a web panel.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db');
const settings = require('../util/settings');
const { config } = require('../config');

const DIR = () => path.resolve(process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'));

const pgDump = () => require('./backup').pgDump();

async function runScheduled({ trigger = 'schedule', adminId = null } = {}) {
  if (!(await settings.bool('backup_scheduled_enabled', false))) return { ok: false, skipped: true, message: 'Scheduled backups are switched off (Settings → backup_scheduled_enabled).' };
  const dir = DIR();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = require('./backup').filename();
  const file = path.join(dir, name);
  const row = await db.one(`INSERT INTO backups (file_name, trigger, admin_id) VALUES ($1, $2, $3) RETURNING id`, [name, trigger, adminId]);
  const result = await new Promise((resolve) => {
    const out = fs.createWriteStream(file, { mode: 0o600 });
    const p = spawn(pgDump(), ['-Fc', '--no-owner', '--no-acl', '-h', config.db.host, '-p', String(config.db.port), '-U', config.db.user, '-d', config.db.database],
      { env: { ...process.env, PGPASSWORD: config.db.password }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stdout.pipe(out);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { err += e.message; });
    p.on('close', (code) => out.end(() => resolve({ ok: code === 0, err: err.trim().split('\n').pop() || (code === 0 ? '' : 'pg_dump failed') })));
  });
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (!result.ok || !size) {
    try { fs.unlinkSync(file); } catch { /* nothing written */ }
    await db.query(`UPDATE backups SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [row.id, result.err.slice(0, 300)]);
    return { ok: false, id: String(row.id), message: result.err };
  }
  await db.query(`UPDATE backups SET status = 'success', finished_at = now(), size_bytes = $2 WHERE id = $1`, [row.id, size]);
  // Retention: older scheduled files go; their rows stay, marked deleted.
  const keep = await settings.num('backup_retention_days', 7);
  const { rows: old } = await db.query(`SELECT id, file_name FROM backups WHERE status = 'success' AND started_at < now() - ($1 || ' days')::interval`, [String(keep)]);
  for (const o of old) {
    try { fs.unlinkSync(path.join(dir, path.basename(o.file_name))); } catch { /* already gone */ }
    await db.query(`UPDATE backups SET status = 'deleted' WHERE id = $1`, [o.id]);
  }
  return { ok: true, id: String(row.id), size_bytes: size, pruned: old.length };
}

async function status() {
  const [scheduled, downloads, enabled, keep, staleH, dbh] = await Promise.all([
    db.query(`SELECT b.id, b.started_at, b.finished_at, b.status, b.file_name, b.size_bytes, b.error, b.trigger, a.name AS admin
                FROM backups b LEFT JOIN admin_users a ON a.id = b.admin_id ORDER BY b.id DESC LIMIT 30`),
    db.query(`SELECT x.id, x.created_at, x.action, x.detail, a.name AS admin FROM admin_audit x LEFT JOIN admin_users a ON a.id = x.admin_id
               WHERE x.action IN ('database_downloaded', 'database_download_failed') ORDER BY x.id DESC LIMIT 30`),
    settings.bool('backup_scheduled_enabled', false), settings.num('backup_retention_days', 7), settings.num('alert_backup_stale_hours', 168),
    db.one(`SELECT pg_database_size(current_database()) AS size_bytes,
                   (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS connections,
                   (SELECT sum(xact_rollback)::bigint FROM pg_stat_database WHERE datname = current_database()) AS rollbacks,
                   (SELECT sum(deadlocks)::bigint FROM pg_stat_database WHERE datname = current_database()) AS deadlocks`).catch(() => null),
  ]);
  const history = [
    ...scheduled.rows.map((b) => ({ id: `s${b.id}`, kind: 'scheduled', at: b.finished_at || b.started_at, status: b.status, size_bytes: b.size_bytes ? Number(b.size_bytes) : null,
      file: b.file_name, error: b.error, by: b.trigger === 'manual' ? b.admin : 'Schedule' })),
    ...downloads.rows.map((d) => ({ id: `d${d.id}`, kind: 'download', at: d.created_at, status: d.action === 'database_downloaded' ? 'success' : 'failed',
      size_bytes: d.detail?.bytes ?? null, file: d.detail?.file || null, error: null, by: d.admin })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  const last = history.find((h) => h.status === 'success' || h.status === 'deleted') || null;
  const lastAttempt = history[0] || null;
  const ageH = last ? Math.round((Date.now() - new Date(last.at)) / 3600000) : null;
  const kept = scheduled.rows.filter((b) => b.status === 'success').length;
  return {
    last, last_attempt: lastAttempt, age_hours: ageH,
    state: !last ? 'none' : lastAttempt?.status === 'failed' ? 'failed' : ageH > staleH ? 'stale' : 'ok',
    stale_after_hours: staleH,
    scheduled: { enabled, retention_days: keep, files_kept: kept, dir: enabled ? path.basename(DIR()) : null },
    database: dbh ? { size_mb: Math.round(Number(dbh.size_bytes) / 1048576), connections: dbh.connections,
      rollbacks: Number(dbh.rollbacks || 0), deadlocks: Number(dbh.deadlocks || 0) } : null,
    history: history.slice(0, 40),
    notes: {
      restore: 'There is no restore from the panel. Restoring replaces the live database; it is done on the server with pg_restore by a person who has the file.',
      scheduled: 'Scheduled backups are written on this server and are off unless switched on in Settings. The owner’s download from “Maintenance” leaves no copy on the server.',
    },
  };
}

module.exports = { status, runScheduled };
