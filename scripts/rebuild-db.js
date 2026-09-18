/**
 * scripts/rebuild-db.js — drop the database, create it again, build every table
 * and put the contents in (user, 2026-09-18).
 *
 *   node scripts/rebuild-db.js --confirm=serverpe_gaadipe
 *   node scripts/rebuild-db.js --confirm=serverpe_gaadipe --owner=9886122415 --owner-name="Shivakumar Kirigeri"
 *   node scripts/rebuild-db.js --sql=gaadipe_full.sql          # write one psql script instead
 *
 * WHAT IT DOES, in order:
 *   1. connects to the "postgres" maintenance database with the PG* settings
 *      from .env, ends every other connection to PGDATABASE, DROPs it and
 *      CREATEs it again (the PGUSER role needs CREATEDB);
 *   2. applies every file in migrations/ in order — which creates every table
 *      AND puts in the contents: the ₹19 plan, the policies and terms, the
 *      business details (GSTIN, address, grievance officer), every setting;
 *   3. adds the admin panel's owner, so the passcode has someone to sign in as;
 *   4. prints what is there.
 *
 * With --sql=<file> nothing is touched: it writes a single script for psql —
 * DROP DATABASE, CREATE DATABASE, \connect, every migration, the owner — to run
 * as  psql -U <superuser> -f gaadipe_full.sql
 *
 * IT DELETES EVERYTHING. It will not run without --confirm=<the database name>,
 * and with NODE_ENV=production it also needs --production.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const arg = (name) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};

const DB = process.env.PGDATABASE;
const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const OWNER = String(arg('owner') || process.env.ADMIN_OWNER_MOBILE || '9886122415').replace(/\D/g, '').slice(-10);
const OWNER_NAME = String(arg('owner-name') || process.env.ADMIN_OWNER_NAME || 'Shivakumar Kirigeri');
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const files = () => fs.readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

function ownerSql() {
  return `INSERT INTO admin_users (mobile, name, role, is_active)
VALUES (${lit(OWNER)}, ${lit(OWNER_NAME)}, 'owner', true)
ON CONFLICT (mobile) DO UPDATE SET role = 'owner', is_active = true, name = EXCLUDED.name;`;
}

/* ─────────────────────────────────────────────── --sql: one psql script ── */
function writeSql(out) {
  const parts = [
    `-- GaadiPe: the whole database from nothing — generated ${new Date().toISOString()}`,
    `-- Run as a role that may drop and create databases:  psql -U postgres -f ${path.basename(out)}`,
    `-- IT DELETES THE DATABASE ${DB} AND EVERYTHING IN IT.`,
    '\\set ON_ERROR_STOP on',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${lit(DB)} AND pid <> pg_backend_pid();`,
    `DROP DATABASE IF EXISTS ${ident(DB)};`,
    `CREATE DATABASE ${ident(DB)}${process.env.PGUSER ? ` OWNER ${ident(process.env.PGUSER)}` : ''} ENCODING 'UTF8';`,
    `\\connect ${ident(DB)}`,
    process.env.PGUSER ? `SET ROLE ${ident(process.env.PGUSER)};` : '',
    // The same ledger scripts/migrate.js keeps, so later migrations apply on top.
    `CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`,
  ];
  for (const f of files()) {
    parts.push(`\n-- ─────────────── ${f} ───────────────\nBEGIN;\n${fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')}\nINSERT INTO schema_migrations (filename) VALUES (${lit(f)}) ON CONFLICT DO NOTHING;\nCOMMIT;`);
  }
  parts.push(`\n-- The admin panel's owner: the passcode signs in as this account.\n${ownerSql()}`);
  fs.writeFileSync(out, parts.filter(Boolean).join('\n'));
  console.log(`\n  wrote ${out} — ${files().length} migrations + owner ${OWNER}\n`);
}

/* ───────────────────────────────────────────────────── the direct way ── */
async function rebuild() {
  if (!DB) throw new Error('PGDATABASE is not set in .env');
  if (arg('confirm') !== DB) {
    throw new Error(`This DELETES the database "${DB}". Run again with --confirm=${DB} if that is what you want.`);
  }
  if (String(process.env.NODE_ENV).toLowerCase() === 'production' && !arg('production')) {
    throw new Error('NODE_ENV=production: add --production as well, to say you mean the live database.');
  }

  const admin = new Client({ database: process.env.PG_MAINTENANCE_DB || 'postgres' });
  await admin.connect();
  console.log(`\n  1. dropping and creating "${DB}"…`);
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]);
  await admin.query(`DROP DATABASE IF EXISTS ${ident(DB)}`);
  await admin.query(`CREATE DATABASE ${ident(DB)}${process.env.PGUSER ? ` OWNER ${ident(process.env.PGUSER)}` : ''} ENCODING 'UTF8'`);
  await admin.end();

  console.log(`  2. building every table and putting the contents in (${files().length} migrations)…`);
  const run = spawnSync(process.execPath, [path.join(__dirname, 'migrate.js')], { stdio: 'inherit', env: process.env });
  if (run.status !== 0) throw new Error('A migration failed — see above. The database is partly built; fix and run again.');

  console.log(`  3. adding the admin owner ${OWNER} (${OWNER_NAME})…`);
  const db = new Client({ database: DB });
  await db.connect();
  await db.query(ownerSql());

  const count = async (sql) => (await db.query(sql)).rows[0].n;
  const summary = {
    tables: await count(`SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'`),
    migrations: await count(`SELECT count(*)::int n FROM schema_migrations`),
    plans: await count(`SELECT count(*)::int n FROM plans`),
    settings: await count(`SELECT count(*)::int n FROM app_settings`),
    terms_clauses: await count(`SELECT count(*)::int n FROM terms_and_conditions`),
    privacy_clauses: await count(`SELECT count(*)::int n FROM privacy_policy`),
    business: (await db.query(`SELECT business_name, gstin FROM business_details WHERE is_active LIMIT 1`)).rows[0] || null,
    owner: (await db.query(`SELECT mobile, name, role FROM admin_users WHERE role = 'owner'`)).rows,
  };
  await db.end();
  console.log('  4. done:\n', JSON.stringify(summary, null, 2), '\n');
}

(async () => {
  try {
    const sql = arg('sql');
    if (sql) writeSql(sql === true ? 'gaadipe_full.sql' : sql);
    else await rebuild();
    process.exit(0);
  } catch (e) {
    console.error(`\n  ✖ ${e.message}\n`);
    process.exit(1);
  }
})();
