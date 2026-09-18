/**
 * scripts/identify-leak.js — which account did this data come from?
 *
 *   node scripts/identify-leak.js path/to/leaked.json
 *
 * Every full vehicle record GaadiPe sends is watermarked with a field order
 * unique to the account that received it (src/security/watermark.js). Given a
 * copy found elsewhere — a JSON file, a paste, a scraped dump — this scores it
 * against every account that has opened full records and prints the closest
 * matches. A genuine source scores close to 1.00; everyone else sits near 0.50.
 *
 * The file must still be JSON with its original field order (as a copy/paste or
 * a saved response is). Needs the same VEHICLE_LOOKUP_KEY as the server.
 */

require('dotenv').config();
const fs = require('fs');
const db = require('../src/db');
const { score } = require('../src/security/watermark');

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('\n  usage: node scripts/identify-leak.js <leaked.json>\n'); process.exit(1); }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    console.error(`\n  could not read JSON from ${file}: ${e.message}\n`); process.exit(1);
  }
  // A response saved from the site may still be wrapped: { vehicle: {...} }.
  const target = doc?.vehicle && typeof doc.vehicle === 'object' ? doc.vehicle : doc;

  const { rows } = await db.query(
    `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
            count(e.id)::int AS full_views, max(e.created_at) AS last_view
       FROM users u JOIN event_log e ON e.user_id = u.id AND e.kind = 'full_view'
      GROUP BY u.id ORDER BY max(e.created_at) DESC`);
  if (!rows.length) { console.log('\n  No account has opened a full record yet.\n'); process.exit(0); }

  const ranked = rows.map((r) => ({ ...r, s: score(target, String(r.id)) })).sort((a, b) => b.s - a.s);
  console.log('\n  Closest matches (1.00 = certain, ~0.50 = unrelated):\n');
  for (const r of ranked.slice(0, 10)) {
    const m = String(r.mobile || '');
    console.log(`  ${r.s.toFixed(2)}  account ${r.id}  ${r.name || '—'}  ••••${m.slice(-4)}  (${r.full_views} full views, last ${new Date(r.last_view).toISOString().slice(0, 10)})`);
  }
  const [best, next] = ranked;
  console.log(best.s > 0.9 && (!next || best.s - next.s > 0.2)
    ? `\n  → Very likely account ${best.id}.\n` : '\n  → No clear match. The copy may have been re-ordered or is not from GaadiPe.\n');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
