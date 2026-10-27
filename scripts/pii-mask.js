/**
 * scripts/pii-mask.js — MASK THE FULL OWNER DATA ALREADY SAVED (user, 2026-10-27: DPDP Act; pii-audit.js found 260
 * vehicle records and 29 reports holding the owner's full name, address, chassis and engine).
 *
 *   node scripts/pii-mask.js            dry run: counts what would change, changes nothing
 *   node scripts/pii-mask.js --apply    masks them, in one transaction
 *
 * Every RC object marked pii_full (rc_backup_store_full) - wherever it sits in the JSON - gets the same masking the
 * sources use when storing masked (vehicle/rcBackup.js): owner name starred, address down to its pincode, the last
 * five characters of chassis and engine starred; the pii_full mark is removed so store.guardRc protects it from then
 * on. Nothing else changes: make, model, dates, insurer, policy, financer, owner count stay. Prints counts only.
 *
 * CANNOT BE UNDONE. Switch rc_backup_store_full OFF in admin first, or new full records keep arriving.
 */
require('dotenv').config();
const db = require('../src/db');
const { maskName, maskTail, maskAddress } = require('../src/vehicle/rcBackup')._test;

const apply = process.argv.includes('--apply');

/* Walk the JSON; mask each object marked pii_full. Returns how many were masked. */
function maskAll(node) {
  if (!node || typeof node !== 'object') return 0;
  let n = 0;
  if (!Array.isArray(node) && node.pii_full === true) {
    if (node.owner_name) node.owner_name = maskName(node.owner_name);
    if (node.address) node.address = maskAddress(node.address);
    if (node.chassis) node.chassis = maskTail(node.chassis);
    if (node.engine) node.engine = maskTail(node.engine);
    delete node.pii_full;
    n += 1;
  }
  for (const v of Object.values(node)) n += maskAll(v);
  return n;
}

const TARGETS = [
  { label: 'Saved vehicle records', table: 'vehicle_snapshots', cols: ['data', 'raw'] },
  { label: 'Paid reports', table: 'vehicle_reports', cols: ['snapshot'] },
  { label: 'Fleet daily reports', table: 'fleet_reports', cols: ['snapshot'] },
];

(async () => {
  const set = await db.one(`SELECT value FROM app_settings WHERE key = 'rc_backup_store_full'`).catch(() => null);
  const storeFull = String(set?.value ?? 'true') !== 'false';
  console.log(`\n${apply ? 'APPLYING' : 'DRY RUN (nothing changed)'} · rc_backup_store_full is ${storeFull ? 'ON' : 'OFF'}`);
  if (storeFull) console.log('  ⚠️  Switch it OFF in admin Settings first, or new full records keep being saved.');
  console.log('');

  const total = { rows: 0, objects: 0 };
  await db.tx(async (c) => {
    for (const t of TARGETS) {
      const where = t.cols.map((col) => `${col}::text LIKE '%"pii_full": true%'`).join(' OR ');
      const { rows } = await c.query(`SELECT id, ${t.cols.join(', ')} FROM ${t.table} WHERE ${where} FOR UPDATE`);
      let objects = 0;
      for (const r of rows) {
        const sets = []; const args = [r.id];
        for (const col of t.cols) {
          if (!r[col]) continue;
          const m = maskAll(r[col]);
          if (!m) continue;
          objects += m;
          args.push(JSON.stringify(r[col]));
          sets.push(`${col} = $${args.length}::jsonb`);
        }
        if (apply && sets.length) await c.query(`UPDATE ${t.table} SET ${sets.join(', ')} WHERE id = $1`, args);
      }
      console.log(`  ${t.label.padEnd(24)} ${String(rows.length).padStart(5)} rows · ${objects} full records ${apply ? 'masked' : 'to mask'}`);
      total.rows += rows.length; total.objects += objects;
    }
  });

  console.log(`\n  Total: ${total.rows} rows, ${total.objects} full records ${apply ? 'MASKED' : 'would be masked'}.`);
  console.log(apply ? '\nDone. Run node scripts/pii-audit.js - every count should now be 0.\n'
    : '\nNothing was changed. Run with --apply to mask them.\n');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
