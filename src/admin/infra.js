/**
 * src/admin/infra.js — the server under GaadiPe (user, 2026-09-25,
 * operations module phase 5).
 * ---------------------------------------------------------------------------
 *   snapshot()  CPU and load, memory, disk, network interfaces (names and
 *               counters only), this Node process, PM2's applications, nginx,
 *               Postgres (connections, size, version), the site's SSL
 *               certificate expiry and the domain's registration expiry
 *
 * Each check answers for itself and fails on its own: a server without PM2 or
 * systemctl says "Not available", it does not break the page. Nothing here
 * reads or returns a credential, an environment value or a file's contents.
 * SSL and domain look-ups are cached for six hours (the domain's is a public
 * RDAP query for the registration date — nothing about GaadiPe is sent).
 * ---------------------------------------------------------------------------
 */

const os = require('os');
const fs = require('fs');
const tls = require('tls');
const { execFile } = require('child_process');
const db = require('../db');

const run = (cmd, args, ms = 4000) => new Promise((resolve) => {
  // Some platforms refuse a command outright (a .cmd on Windows) — that is "not available", not a crash.
  try {
    execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  } catch { resolve(null); }
});

/* The public site's host — never a local address, whatever a dev .env says. */
const siteHost = () => {
  if (process.env.SSL_CHECK_HOST) return process.env.SSL_CHECK_HOST;
  for (const u of [process.env.SITE_URL, process.env.PUBLIC_SITE_URL]) {
    try {
      const h = new URL(u).hostname;
      if (h && !/^(localhost|127\.|10\.|192\.168\.|\[?::1)/.test(h) && /\.[a-z]{2,}$/i.test(h)) return h;
    } catch { /* not a URL */ }
  }
  return 'gaadipe.in';
};

function cpu() {
  const load = os.loadavg(); const cores = os.cpus().length || 1;
  // loadavg is 0,0,0 on Windows — say so rather than show a flat line.
  const measured = process.platform !== 'win32';
  return { cores, model: os.cpus()[0]?.model || null, load_1m: measured ? load[0] : null, load_5m: measured ? load[1] : null,
    load_15m: measured ? load[2] : null, load_pct: measured ? Math.round((load[0] / cores) * 100) : null };
}

function memory() {
  const total = os.totalmem(); const free = os.freemem();
  return { total_mb: Math.round(total / 1048576), used_mb: Math.round((total - free) / 1048576), used_pct: Math.round(((total - free) / total) * 100) };
}

function disk() {
  try {
    const p = process.platform === 'win32' ? process.cwd().slice(0, 3) : '/';
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize; const free = s.bavail * s.bsize;
    return { path: p, total_gb: Math.round((total / 1073741824) * 10) / 10, free_gb: Math.round((free / 1073741824) * 10) / 10,
      used_pct: total ? Math.round(((total - free) / total) * 100) : null };
  } catch { return null; }
}

function network() {
  return Object.entries(os.networkInterfaces()).filter(([, a]) => (a || []).some((x) => !x.internal))
    .map(([name, a]) => ({ name, families: [...new Set(a.map((x) => x.family))] }));
}

async function pm2() {
  const out = await run(process.platform === 'win32' ? 'pm2.cmd' : 'pm2', ['jlist']);
  if (!out) return null;
  try {
    return JSON.parse(out.slice(out.indexOf('['))).map((p) => ({
      name: p.name, status: p.pm2_env?.status || null, restarts: p.pm2_env?.restart_time ?? null,
      uptime_min: p.pm2_env?.pm_uptime ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 60000) : null,
      memory_mb: p.monit?.memory != null ? Math.round(p.monit.memory / 1048576) : null, cpu_pct: p.monit?.cpu ?? null,
    }));
  } catch { return null; }
}

async function nginx() {
  if (process.platform === 'win32') return null;
  const out = await run('systemctl', ['is-active', 'nginx']);
  return out == null ? null : out.trim();
}

async function postgres() {
  try {
    const r = await db.one(
      `SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS connections,
              (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active')::int AS active,
              current_setting('max_connections')::int AS max_connections,
              pg_database_size(current_database()) AS size_bytes,
              split_part(version(), ' ', 2) AS version,
              (SELECT extract(epoch FROM now() - pg_postmaster_start_time()))::int AS uptime_s`);
    return { ...r, size_mb: Math.round(Number(r.size_bytes) / 1048576), size_bytes: undefined };
  } catch { return null; }
}

const cache = new Map();
async function cached(key, ms, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ms) return c.value;
  const value = await fn().catch(() => null);
  cache.set(key, { at: Date.now(), value });
  return value;
}

function ssl(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 6000 }, () => {
      const c = s.getPeerCertificate(); s.end();
      if (!c?.valid_to) return resolve(null);
      const to = new Date(c.valid_to);
      resolve({ host, valid_to: to, days_left: Math.floor((to - Date.now()) / 86400000), issuer: c.issuer?.O || c.issuer?.CN || null });
    });
    s.on('error', () => resolve(null)); s.on('timeout', () => { s.destroy(); resolve(null); });
  });
}

/* The registry's RDAP server for a TLD, from IANA's bootstrap file (cached a day). */
async function rdapBase(tld) {
  const map = await cached('rdap-bootstrap', 24 * 3600e3, async () => {
    const r = await fetch('https://data.iana.org/rdap/dns.json', { signal: AbortSignal.timeout(8000) });
    return r.ok ? r.json() : null;
  });
  const svc = (map?.services || []).find(([tlds]) => tlds.includes(tld));
  return svc ? svc[1][0].replace(/\/?$/, '/') : null;
}

async function domain(host) {
  const apex = host.split('.').slice(-2).join('.');
  const base = await rdapBase(apex.split('.').pop());
  if (!base) return null;
  const res = await fetch(`${base}domain/${encodeURIComponent(apex)}`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/rdap+json' } });
  if (!res.ok) return null;
  const j = await res.json();
  const exp = (j.events || []).find((e) => e.eventAction === 'expiration')?.eventDate;
  return exp ? { domain: apex, expires: new Date(exp), days_left: Math.floor((new Date(exp) - Date.now()) / 86400000) } : null;
}

async function snapshot() {
  const host = siteHost();
  const [pm, ng, pg, cert, dom] = await Promise.all([
    pm2(), nginx(), postgres(), cached(`ssl:${host}`, 6 * 3600e3, () => ssl(host)), cached(`rdap:${host}`, 6 * 3600e3, () => domain(host)),
  ]);
  const mem = process.memoryUsage();
  return {
    at: new Date(), host: os.hostname(), platform: `${os.type()} ${os.release()}`, server_uptime_h: Math.round(os.uptime() / 3600),
    cpu: cpu(), memory: memory(), disk: disk(), network: network(),
    node: { version: process.version, pid: process.pid, uptime_min: Math.round(process.uptime() / 60),
      rss_mb: Math.round(mem.rss / 1048576), heap_mb: Math.round(mem.heapUsed / 1048576) },
    pm2: pm, nginx: ng, postgres: pg, ssl: cert, domain: dom,
    notes: { unavailable: 'Not available: the check could not run on this server (for example PM2 or systemctl is not installed).' },
  };
}

module.exports = { snapshot };

/* The cheap facts the alert checker reads every minute (SSL and domain are cached). */
async function alertFacts() {
  const host = siteHost();
  const [cert, dom] = await Promise.all([cached(`ssl:${host}`, 6 * 3600e3, () => ssl(host)), cached(`rdap:${host}`, 6 * 3600e3, () => domain(host))]);
  return { memory: memory(), disk: disk(), ssl: cert, domain: dom };
}
module.exports.alertFacts = alertFacts;
