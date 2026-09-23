/**
 * scripts/schema-audit.js — what the schema has that the code does not use.
 *
 * Read-only. It never drops anything: dropping a table destroys the rows in
 * it, so the decision belongs to a person, and this only tells them what the
 * decision is about.
 *
 * Three verdicts:
 *   KEEP        the code references it
 *   SAFE        no code reference and no rows — nothing is lost by dropping it
 *   HAS DATA    no code reference but rows exist — dropping it destroys them
 *
 * A table can be referenced only in SQL inside a migration and still be live,
 * so the search covers src/ and migrations/ both.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

/** Every .js and .sql under a directory. */
function files(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files(full, out);
    else if (/\.(js|sql)$/.test(entry.name)) out.push(full);
  }
  return out;
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const corpus = files(path.join(root, 'src'))
    .concat(files(path.join(root, 'migrations')))
    .concat(files(path.join(root, 'scripts')))
    .map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }));

  const { rows: tables } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`);

  const results = [];
  for (const { table_name: t } of tables) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM "${t}"`);
    const n = rows[0].n;
    // A reference in src/ is what makes a table live. A mention only in the
    // migration that created it does not.
    const inSrc = corpus.filter((c) => c.f.includes(`${path.sep}src${path.sep}`)
      && new RegExp(`\\b${t}\\b`).test(c.text));
    results.push({ table: t, rows: n, used_by: inSrc.length,
      verdict: inSrc.length ? 'KEEP' : n === 0 ? 'SAFE to drop' : 'HAS DATA — ask' });
  }

  const width = Math.max(...results.map((r) => r.table.length)) + 2;
  const show = (title, list) => {
    if (!list.length) return;
    console.log(`\n${title}`);
    list.forEach((r) => console.log(
      `  ${r.table.padEnd(width)}${String(r.rows).padStart(7)} row(s)`
      + (r.used_by ? `   referenced in ${r.used_by} file(s)` : '')));
  };

  show('UNUSED AND EMPTY — nothing is lost by dropping these:',
    results.filter((r) => r.verdict === 'SAFE to drop'));
  show('UNUSED BUT HOLDS DATA — dropping destroys these rows:',
    results.filter((r) => r.verdict === 'HAS DATA — ask'));
  show('IN USE:', results.filter((r) => r.verdict === 'KEEP'));

  /*
   * COLUMNS, WHERE THE REAL DEAD WEIGHT HIDES.
   *
   * A column is reported only when BOTH are true: no file in src/ mentions it,
   * and every row is null. The second half matters — a column nothing reads
   * but every row fills is usually something a migration back-filled for a
   * feature about to use it, not rubbish.
   *
   * Names too short or too common to search for are skipped entirely. A false
   * positive here costs real data, so the rule is deliberately timid.
   */
  const COMMON = new Set(['id', 'name', 'code', 'value', 'key', 'type', 'kind', 'status',
    'data', 'text', 'body', 'url', 'ip', 'detail', 'source', 'label', 'title', 'state']);

  const dead = [];
  for (const { table, rows: rowCount, verdict } of results) {
    if (verdict !== 'KEEP' || rowCount === 0) continue;
    const { rows: cols } = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`, [table]);
    for (const { column_name: c } of cols) {
      if (c.length < 5 || COMMON.has(c)) continue;
      const mentioned = corpus.some((f) => f.f.includes(`${path.sep}src${path.sep}`)
        && new RegExp(`\\b${c}\\b`).test(f.text));
      if (mentioned) continue;
      const { rows: filled } = await db.query(`SELECT count("${c}")::int AS n FROM "${table}"`);
      if (filled[0].n === 0) dead.push(`${table}.${c}`);
    }
  }

  console.log(dead.length
    ? `\nCOLUMNS NO CODE READS, AND NULL IN EVERY ROW:\n  ${dead.join('\n  ')}`
    : '\nNo dead columns found.');

  console.log(`\n${results.length} tables · `
    + `${results.filter((r) => r.verdict === 'KEEP').length} in use · `
    + `${results.filter((r) => r.verdict === 'SAFE to drop').length} unused and empty · `
    + `${results.filter((r) => r.verdict === 'HAS DATA — ask').length} unused with data`);
  console.log('\nNothing was changed. This script only reads.');
  process.exit(0);
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
