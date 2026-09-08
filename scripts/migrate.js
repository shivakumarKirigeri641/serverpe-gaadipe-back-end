/**
 * scripts/migrate.js
 * ---------------------------------------------------------------------------
 *   node scripts/migrate.js           apply anything not yet applied
 *   node scripts/migrate.js --check   report only, change nothing
 *   node scripts/migrate.js --fresh   DROP every table, then apply from zero
 *
 * --fresh is deliberately awkward: it refuses when NODE_ENV=production, refuses
 * a protected database name, and waits five seconds after telling you what it
 * is about to destroy. `invoices` holds statutory GST records — a rebuild is
 * cheap, an invoice history is not recoverable.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { config } = require('../src/config');

const CHECK = process.argv.includes('--check');
const FRESH = process.argv.includes('--fresh');
const DIR = path.join(__dirname, '..', 'migrations');

// Belong to other products; never droppable whatever the flags say.
const PROTECTED = new Set([
  'postgres', 'template0', 'template1',
  'serverpe_quizpe', 'serverpe_gamepe', 'serverpe_verifyvahan',
  'serverpe_challanalerts', 'quizpe_live_0905',
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const client = () => new Client({ ...config.db });

async function dropEverything(c) {
  if (config.env === 'production') throw new Error('--fresh refuses to run with NODE_ENV=production.');
  if (PROTECTED.has(config.db.database)) throw new Error(`--fresh refuses to touch "${config.db.database}".`);

  const { rows } = await c.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  if (!rows.length) return;

  console.log(`\n  ⚠  About to DROP ${rows.length} table(s) in "${config.db.database}":`);
  console.log('     ' + rows.map(r => r.tablename).join(', '));
  console.log('     Ctrl-C now if that is not what you want.\n');
  await sleep(5000);
  // One statement, so foreign keys cannot block the order.
  await c.query(`DROP TABLE IF EXISTS ${rows.map(r => `"${r.tablename}"`).join(', ')} CASCADE`);
  console.log(`  dropped   ${rows.length} table(s)`);
}

(async () => {
  const c = client();
  await c.connect();
  console.log(`\nGaadiPe migrations — ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
  console.log(`  mode: ${FRESH ? 'FRESH (drop all)' : CHECK ? 'check only' : 'apply'}   env: ${config.env}\n`);

  try {
    if (FRESH && !CHECK) await dropEverything(c);

    await c.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
    const done = new Set((await c.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename));

    let applied = 0, missing = 0;
    for (const f of files) {
      if (done.has(f)) { console.log(`  ok        ${f}`); continue; }
      if (CHECK) { console.log(`  MISSING   ${f}`); missing++; continue; }

      // Each migration is one transaction: it applies completely or not at all,
      // so a failure never leaves the schema half-built.
      await c.query('BEGIN');
      try {
        await c.query(fs.readFileSync(path.join(DIR, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
        await c.query('COMMIT');
        console.log(`  applied   ${f}`);
        applied++;
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`${f} failed: ${e.message}`);
      }
    }

    if (CHECK) {
      console.log(missing ? `\n  ${missing} migration(s) not yet applied.\n` : '\n  Schema is up to date.\n');
      process.exit(missing ? 1 : 0);
    }
    console.log(applied ? `\n  ${applied} migration(s) applied.\n` : '\n  Schema is up to date.\n');
    process.exit(0);
  } catch (e) {
    console.error('\nmigration failed:', e.message, '\n');
    process.exit(1);
  } finally {
    await c.end();
  }
})();
