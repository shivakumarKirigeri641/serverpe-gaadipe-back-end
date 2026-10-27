/**
 * scripts/pii-audit.js — HOW MUCH FULL OWNER DATA IS SAVED? (user, 2026-10-27: DPDP Act - "check first, lets see").
 * Read-only: COUNTS only, no name, address or number is printed. Nothing is changed.
 *
 *   node scripts/pii-audit.js
 *
 * Full = saved as the paid RC source sent it (rc_backup_store_full, marked pii_full), or any owner name / chassis /
 * engine without stars. Looks in: saved vehicle records (data and raw), paid reports, fleet daily reports.
 */
require('dotenv').config();
const db = require('../src/db');

const n = (sql, args = []) => db.one(sql, args).then((r) => r || {}).catch((e) => ({ error: e.message }));
// An owner name / chassis / engine with no stars ('*' or '•') in it.
const bare = (col) => `(${col} ~ '[A-Za-z0-9]{3,}' AND ${col} !~ '[*•]')`;
const show = (label, r) => console.log(r.error ? `  ${label}: ${r.error}` : `  ${label.padEnd(34)} ${String(r.n ?? 0).padStart(6)}`);

(async () => {
  const set = await n(`SELECT value FROM app_settings WHERE key = 'rc_backup_store_full'`);
  console.log(`\nrc_backup_store_full: ${set.value ?? '(not set - default ON)'}\n`);

  console.log('Saved vehicle records (vehicle_snapshots, rc):');
  show('vehicles saved', await n(`SELECT count(*)::int AS n FROM vehicle_snapshots WHERE dataset = 'rc'`));
  show('marked full (pii_full)', await n(`SELECT count(*)::int AS n FROM vehicle_snapshots WHERE dataset = 'rc' AND data->>'pii_full' = 'true'`));
  show('owner name unmasked', await n(`SELECT count(*)::int AS n FROM vehicle_snapshots WHERE dataset = 'rc' AND ${bare(`data->>'owner_name'`)}`));
  show('chassis unmasked', await n(`SELECT count(*)::int AS n FROM vehicle_snapshots WHERE dataset = 'rc' AND length(data->>'chassis') >= 8 AND ${bare(`data->>'chassis'`)}`));
  show('engine unmasked', await n(`SELECT count(*)::int AS n FROM vehicle_snapshots WHERE dataset = 'rc' AND length(data->>'engine') >= 5 AND ${bare(`data->>'engine'`)}`));
  show('address on full records', await n(`SELECT count(*)::int AS n FROM vehicle_snapshots WHERE dataset = 'rc' AND data->>'pii_full' = 'true' AND coalesce(data->>'address', '') <> ''`));
  show('raw copy marked full', await n(`SELECT count(*)::int AS n FROM vehicle_snapshots WHERE dataset = 'rc' AND raw->>'pii_full' = 'true'`));

  console.log('\nPaid reports (vehicle_reports):');
  show('reports', await n(`SELECT count(*)::int AS n FROM vehicle_reports`));
  show('holding a full record', await n(`SELECT count(*)::int AS n FROM vehicle_reports WHERE snapshot::text LIKE '%"pii_full": true%'`));
  show('  of them still downloadable', await n(`SELECT count(*)::int AS n FROM vehicle_reports WHERE snapshot::text LIKE '%"pii_full": true%' AND valid_until > now()`));

  console.log('\nFleet daily reports (fleet_reports):');
  show('holding a full record', await n(`SELECT count(*)::int AS n FROM fleet_reports WHERE snapshot::text LIKE '%"pii_full": true%'`));

  console.log('\nOldest and newest full record:');
  const span = await n(`SELECT min(fetched_at) AS a, max(fetched_at) AS b FROM vehicle_snapshots WHERE dataset = 'rc' AND data->>'pii_full' = 'true'`);
  const ist = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '-');
  console.log(span.error ? `  ${span.error}` : `  ${ist(span.a)}  →  ${ist(span.b)}`);

  const old = await n(`SELECT count(*)::int AS n FROM vehicle_snapshots s WHERE s.dataset = 'rc' AND s.data->>'pii_full' = 'true'
                         AND s.fetched_at < now() - interval '90 days'`);
  show('full records older than 90 days', old);
  console.log('\nNothing was changed.\n');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
