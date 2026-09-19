/**
 * scripts/server-docs.js
 * ---------------------------------------------------------------------------
 * Copy the server's database to this laptop and rebuild its invoices and
 * vehicle reports here, exactly as they were issued.
 *
 *   node scripts/server-docs.js                      download, then rebuild everything
 *   node scripts/server-docs.js --invoice INV20260818GP1
 *   node scripts/server-docs.js --report RPT…        one report only
 *   node scripts/server-docs.js --no-download        rebuild from the copy already here
 *   node scripts/server-docs.js --list               download, then only list what is there
 *
 * HOW. The server dumps its own database (its .env has the credentials, so
 * none are kept here) and the dump comes down over ssh. It is restored into a
 * SEPARATE local database, serverpe_gaadipe_server — never the local
 * serverpe_gaadipe you develop against — and rebuild-invoice.js and
 * rebuild-report.js render each document from its row: invoices from the
 * invoice row, reports from the snapshot stored with them. Same numbers, same
 * contents, whatever the vehicle's data is today.
 *
 * WHERE IT GOES. server-docs/ in this repo, ignored by git — the copy holds
 * customer data:
 *   server-docs/serverpe_gaadipe_server.dump
 *   server-docs/<date>/invoices/INV….pdf
 *   server-docs/<date>/reports/RPT….pdf
 *
 * Nothing on the server is changed: pg_dump only reads.
 *
 * Settings (environment, all optional):
 *   GAADIPE_SSH     root@31.97.206.85
 *   GAADIPE_DIR     /var/www/serverpe-gaadipe-back-end    (the server's back-end folder)
 *   PG_BIN          C:\Program Files\PostgreSQL\17\bin   (found automatically)
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Client } = require('pg');

const SSH = process.env.GAADIPE_SSH || 'root@31.97.206.85';
const REMOTE_DIR = process.env.GAADIPE_DIR || '/var/www/serverpe-gaadipe-back-end';
const LOCAL_DB = 'serverpe_gaadipe_server';

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'server-docs');
const DUMP = path.join(OUT, `${LOCAL_DB}.dump`);

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

/** pg_restore / createdb / dropdb: on PATH, or in the newest PostgreSQL install. */
function pgBin(tool) {
  if (process.env.PG_BIN) return path.join(process.env.PG_BIN, tool);
  if (spawnSync(tool, ['--version']).status === 0) return tool;
  const base = 'C:\\Program Files\\PostgreSQL';
  if (fs.existsSync(base)) {
    const versions = fs.readdirSync(base).filter((v) => /^\d+$/.test(v)).sort((a, b) => b - a);
    for (const v of versions) {
      const exe = path.join(base, v, 'bin', `${tool}.exe`);
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error(`${tool} not found: install PostgreSQL client tools or set PG_BIN`);
}

const pgEnv = { ...process.env, PGHOST: process.env.PGHOST || 'localhost', PGUSER: process.env.PGUSER || 'postgres' };

function run(cmd, cmdArgs, { allowFail = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { env: pgEnv, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`${path.basename(cmd)} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return r;
}

/** The server dumps itself; the bytes come down ssh into a local file. */
function download() {
  fs.mkdirSync(OUT, { recursive: true });
  const remote = [
    `cd ${REMOTE_DIR}`,
    'set -a && . ./.env && set +a',
    'DB="${PGDATABASE:-$PGDATABASEMAIN}"',
    'echo "server database: $DB" >&2',
    'PGPASSWORD="$PGPASSWORD" pg_dump -Fc --no-owner --no-acl -h "${PGHOST:-127.0.0.1}" -U "$PGUSER" -d "$DB"',
  ].join(' && ');
  console.log(`\n  downloading the database from ${SSH} …`);
  const tmp = `${DUMP}.part`;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmp);
    // stdin is inherited so ssh can ask for a password or passphrase if it needs one.
    const p = spawn('ssh', [SSH, remote], { stdio: ['inherit', 'pipe', 'inherit'] });
    p.stdout.pipe(file);
    p.on('error', reject);
    p.on('close', (code) => {
      file.close(() => {
        const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
        if (code !== 0 || size < 1024) {
          fs.rmSync(tmp, { force: true });
          return reject(new Error(`download failed (ssh exit ${code}, ${size} bytes)`));
        }
        fs.renameSync(tmp, DUMP);
        console.log(`  saved ${path.relative(ROOT, DUMP)} (${(size / 1024).toFixed(0)} KB)`);
        resolve();
      });
    });
  });
}

/** A fresh local copy each time, in its own database. */
function restore() {
  if (!fs.existsSync(DUMP)) throw new Error(`no ${path.relative(ROOT, DUMP)} yet: run without --no-download first`);
  console.log(`  restoring into local database ${LOCAL_DB} (your ${process.env.PGDATABASE || 'serverpe_gaadipe'} is not touched) …`);
  run(pgBin('dropdb'), ['--if-exists', LOCAL_DB]);
  run(pgBin('createdb'), [LOCAL_DB]);
  // Warnings about roles or extensions that exist only on the server are harmless;
  // the rows are what matter, and they are counted below.
  run(pgBin('pg_restore'), ['--no-owner', '--no-acl', '-d', LOCAL_DB, DUMP], { allowFail: true });
}

async function numbers() {
  const c = new Client({ ...pgConn(), database: LOCAL_DB });
  await c.connect();
  try {
    const inv = (await c.query('SELECT invoice_number FROM invoices ORDER BY id')).rows.map((r) => r.invoice_number);
    const rep = (await c.query('SELECT report_number, reg_no FROM vehicle_reports ORDER BY id')).rows;
    return { inv, rep };
  } finally { await c.end(); }
}

function pgConn() {
  return {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
  };
}

/** Render one document with the existing rebuild script, into today's folder. */
function rebuild(script, number, dir) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), number, '--db', LOCAL_DB, '--out', dir],
    { cwd: ROOT, env: process.env, encoding: 'utf8' });
  const ok = r.status === 0 && /written:/.test(r.stdout || '');
  console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${number}${ok ? '' : `  ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`}`);
  return ok;
}

(async () => {
  if (!has('no-download')) await download();
  restore();

  const { inv, rep } = await numbers();
  console.log(`  the server holds ${inv.length} invoices and ${rep.length} reports`);

  if (has('list')) {
    inv.forEach((n) => console.log(`    invoice  ${n}`));
    rep.forEach((r) => console.log(`    report   ${r.report_number}  ${r.reg_no}`));
    return;
  }

  const wantInv = flag('invoice');
  const wantRep = flag('report');
  const only = wantInv || wantRep;
  const invList = wantInv ? [wantInv] : (only ? [] : inv);
  const repList = wantRep ? [wantRep] : (only ? [] : rep.map((r) => r.report_number));

  const day = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const invDir = path.join(OUT, day, 'invoices');
  const repDir = path.join(OUT, day, 'reports');
  let good = 0; let bad = 0;

  if (invList.length) console.log(`\n  invoices → ${path.relative(ROOT, invDir)}`);
  for (const n of invList) (rebuild('rebuild-invoice.js', n, invDir) ? good++ : bad++);
  if (repList.length) console.log(`\n  reports → ${path.relative(ROOT, repDir)}`);
  for (const n of repList) (rebuild('rebuild-report.js', n, repDir) ? good++ : bad++);

  console.log(`\n  ${good} rebuilt${bad ? `, ${bad} failed` : ''} · folder: ${path.join(OUT, day)}\n`);
  if (bad) process.exitCode = 1;
})().catch((e) => {
  console.error(`\n  ${e.message}\n`);
  process.exit(1);
});
