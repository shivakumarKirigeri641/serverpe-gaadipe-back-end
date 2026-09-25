/**
 * src/admin/backup.js — the whole database, downloaded from the panel
 * (user, 2026-09-19).
 *
 * WHAT COMES DOWN is a pg_dump in PostgreSQL's custom format, the same file
 * scripts/server-docs.js fetches over ssh: every table, restorable with
 * pg_restore into any database. It streams straight from pg_dump to the
 * browser — nothing is written on the server, so no copy is left lying about.
 *
 * WHO MAY: the owner only (the 'admins' capability, as for clearing data),
 * after typing DOWNLOAD. It holds every customer's name, number and vehicle,
 * so each download is written to the audit trail against the person who took
 * it, and one owner may take one every ten minutes — enough for a backup,
 * useless for anyone trying to drain the data in a loop.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('../config');
const { audit } = require('./auth');

const EVERY_MS = 10 * 60 * 1000;
const lastBy = new Map();   // admin id -> ms

/** pg_dump: PG_DUMP if set, on PATH on the server, the newest install on Windows. */
function pgDump() {
  if (process.env.PG_DUMP) return process.env.PG_DUMP;
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\PostgreSQL';
    if (fs.existsSync(base)) {
      const v = fs.readdirSync(base).filter((d) => /^\d+$/.test(d)).sort((a, b) => b - a)
        .map((d) => path.join(base, d, 'bin', 'pg_dump.exe')).find((f) => fs.existsSync(f));
      if (v) return v;
    }
  }
  return 'pg_dump';
}

/** Minutes until this admin may download again; 0 when they may now. */
function waitMinutes(adminId) {
  const left = EVERY_MS - (Date.now() - (lastBy.get(adminId) || 0));
  return left > 0 ? Math.ceil(left / 60000) : 0;
}

/** "gaadipe-serverpe_gaadipe-2026-09-19-1742.dump", in IST. */
function filename() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString();
  return `gaadipe-${config.db.database}-${ist.slice(0, 10)}-${ist.slice(11, 16).replace(':', '')}.dump`;
}

/**
 * Stream the dump into an HTTP response. Resolves when it has finished,
 * failed or been abandoned; the audit entry says which.
 */
function stream(res, { adminId, ip }) {
  lastBy.set(adminId, Date.now());
  const name = filename();
  const p = spawn(pgDump(), ['-Fc', '--no-owner', '--no-acl',
    '-h', config.db.host, '-p', String(config.db.port), '-U', config.db.user, '-d', config.db.database], {
    env: { ...process.env, PGPASSWORD: config.db.password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let bytes = 0;
  let err = '';
  let started = false;
  return new Promise((resolve) => {
    p.stdout.on('data', (chunk) => {
      if (!started) {
        started = true;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.setHeader('Cache-Control', 'private, no-store');
      }
      bytes += chunk.length;
      res.write(chunk);
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { err += e.message; });
    res.on('close', () => { if (p.exitCode === null) p.kill(); });

    p.on('close', async (code) => {
      const ok = code === 0 && bytes > 0;
      if (!started) {
        lastBy.delete(adminId);   // nothing was taken, so no wait
        res.status(500).json({ error: 'backup_failed',
          message: `The backup could not be made: ${(err.trim().split('\n').pop() || 'pg_dump is not available')}` });
      } else {
        res.end();
      }
      if (!ok) console.error('[backup] pg_dump exit %s: %s', code, err.trim());
      await audit({ adminId, action: ok ? 'database_downloaded' : 'database_download_failed', ip,
                    detail: { file: name, bytes, database: config.db.database } }).catch(() => {});
      resolve();
    });
  });
}

module.exports = { stream, waitMinutes, filename, pgDump };
