/**
 * scripts/chat-dropoff.js — WHAT THE CHAT VISITORS WHO NEVER CHECKED A VEHICLE DID (user, 2026-10-22: on
 * 21 Oct 150 opened the chat but only 18 typed a vehicle number — "show"). Read-only. For one IST day:
 * who opened /chat and never checked, how long they stayed, what they touched last, which step they got
 * to, their device and where they came from. The owner's own visits are left out (src/admin/notMe.js).
 *
 *   node scripts/chat-dropoff.js                  yesterday
 *   node scripts/chat-dropoff.js --date 2026-10-21
 */
require('dotenv').config();
const db = require('../src/db');
const notMe = require('../src/admin/notMe');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const DATE = arg('--date');

(async () => {
  const w = await db.one(DATE
    ? `SELECT ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata' AS a, ($1::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata' AS b, $1::text AS label`
    : `SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata' - interval '1 day') AT TIME ZONE 'Asia/Kolkata' AS a,
              date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AS b,
              to_char(now() AT TIME ZONE 'Asia/Kolkata' - interval '1 day', 'YYYY-MM-DD') AS label`, DATE ? [DATE] : []);
  const P = [w.a, w.b];
  const IN = `e.channel = 'web' AND e.occurred_at >= $1 AND e.occurred_at < $2 AND ${notMe.evt('e')}`;

  // One row per chat visitor that day, with what they did.
  await db.query(`CREATE TEMP TABLE dv AS
    SELECT e.visitor_id,
           min(e.occurred_at) AS first_at, max(e.occurred_at) AS last_at,
           bool_or(e.user_id IS NOT NULL OR e.mobile IS NOT NULL) AS signed_in,
           count(*) FILTER (WHERE e.name = 'page_view') AS pages,
           count(*) FILTER (WHERE e.name = 'interaction') AS acts,
           bool_or(e.name = 'interaction' AND e.metadata->>'kind' = 'tap') AS tapped,
           bool_or(e.name = 'interaction' AND e.metadata->>'kind' = 'focus') AS focused,
           bool_or(e.name = 'interaction' AND e.metadata->>'kind' = 'typed') AS typed,
           bool_or(e.name = 'interaction' AND e.metadata->>'kind' = 'search' OR e.name LIKE 'vehicle_%') AS searched,
           (array_agg(e.metadata->>'label' ORDER BY e.occurred_at DESC) FILTER (WHERE e.name = 'interaction'))[1] AS last_label,
           (array_agg(e.metadata->>'step' ORDER BY e.occurred_at DESC) FILTER (WHERE e.metadata->>'step' IS NOT NULL))[1] AS last_step,
           (array_agg(e.metadata->>'device') FILTER (WHERE e.metadata->>'device' IS NOT NULL))[1] AS device,
           (array_agg(coalesce(e.campaign, e.source, 'unknown') ORDER BY e.occurred_at))[1] AS came_from
      FROM events e WHERE ${IN} AND e.visitor_id IS NOT NULL
     GROUP BY e.visitor_id
    HAVING bool_or(e.name = 'page_view' AND (e.page LIKE '/chat%' OR e.page LIKE '/go%'))`, P);
  await db.query(`ALTER TABLE dv ADD COLUMN checked boolean`);
  await db.query(`UPDATE dv SET checked = searched OR visitor_id IN
    (SELECT visitor_id FROM anon_checks WHERE created_at >= $1 AND created_at < $2 AND visitor_id IS NOT NULL)`, P);

  const one = (sql) => db.one(sql).then((r) => r);
  const all = (sql) => db.query(sql).then((r) => r.rows);
  const t = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE checked)::int c,
      count(*) FILTER (WHERE NOT checked AND signed_in)::int s, count(*) FILTER (WHERE NOT checked AND NOT signed_in)::int x FROM dv`);
  const L = (s, n) => console.log(`  ${String(s).padEnd(46)}${String(n).padStart(6)}${t.x ? `  ${String(Math.round((n / t.x) * 100)).padStart(3)}%` : ''}`);

  console.log(`\nCHAT VISITORS WHO NEVER CHECKED — ${w.label} (IST, your own visits left out)\n`);
  console.log(`  Opened the chat ${t.n}  ·  checked a vehicle ${t.c}  ·  signed-in, no check ${t.s}  ·  NOT signed in, no check ${t.x}`);
  console.log(`\n  Below: the ${t.x} who were not signed in and never checked (% of them).\n`);

  console.log('HOW LONG THEY STAYED');
  for (const r of await all(`SELECT CASE WHEN s < 5 THEN '1 under 5 seconds' WHEN s < 15 THEN '2 5-15 seconds' WHEN s < 60 THEN '3 15-60 seconds'
      WHEN s < 180 THEN '4 1-3 minutes' ELSE '5 over 3 minutes' END b, count(*)::int n
      FROM (SELECT extract(epoch FROM last_at - first_at) s FROM dv WHERE NOT checked AND NOT signed_in) x GROUP BY 1 ORDER BY 1`)) L(r.b.slice(2), r.n);

  console.log('\nWHAT THEY DID');
  const d = await one(`SELECT count(*) FILTER (WHERE acts = 0)::int none, count(*) FILTER (WHERE tapped)::int tap,
      count(*) FILTER (WHERE focused)::int foc, count(*) FILTER (WHERE typed)::int typ, count(*) FILTER (WHERE pages > 1)::int multi
      FROM dv WHERE NOT checked AND NOT signed_in`);
  L('touched nothing at all (just looked)', d.none);
  L('tapped something', d.tap);
  L('tapped into a box', d.foc);
  L('typed something (but no check sent)', d.typ);
  L('opened more than one page', d.multi);

  console.log('\nTHE STEP THEY WERE ON WHEN THEY LEFT');
  for (const r of await all(`SELECT coalesce(last_step, '(none recorded)') k, count(*)::int n FROM dv WHERE NOT checked AND NOT signed_in GROUP BY 1 ORDER BY 2 DESC LIMIT 10`)) L(r.k, r.n);

  console.log('\nTHE LAST THING THEY DID');
  for (const r of await all(`SELECT coalesce(regexp_replace(last_label, '[0-9•]{4,}', '…', 'g'), '(nothing)') k, count(*)::int n
      FROM dv WHERE NOT checked AND NOT signed_in GROUP BY 1 ORDER BY 2 DESC LIMIT 12`)) L(r.k.slice(0, 46), r.n);

  console.log('\nDEVICE');
  for (const r of await all(`SELECT coalesce(device, 'unknown') k, count(*)::int n FROM dv WHERE NOT checked AND NOT signed_in GROUP BY 1 ORDER BY 2 DESC LIMIT 6`)) L(r.k.slice(0, 46), r.n);

  console.log('\nCAME FROM (ad campaign / source)  — and how many of each DID check');
  console.log(`  ${''.padEnd(46)}${'no check'.padStart(9)}${'checked'.padStart(9)}`);
  for (const r of await all(`SELECT came_from k, count(*) FILTER (WHERE NOT checked AND NOT signed_in)::int x, count(*) FILTER (WHERE checked)::int c
      FROM dv GROUP BY 1 ORDER BY 2 DESC LIMIT 8`)) console.log(`  ${String(r.k).slice(0, 46).padEnd(46)}${String(r.x).padStart(9)}${String(r.c).padStart(9)}`);

  console.log('\nBY HOUR (IST)  no check / checked');
  const hours = await all(`SELECT extract(hour FROM first_at AT TIME ZONE 'Asia/Kolkata')::int h,
      count(*) FILTER (WHERE NOT checked AND NOT signed_in)::int x, count(*) FILTER (WHERE checked)::int c FROM dv GROUP BY 1 ORDER BY 1`);
  console.log('  ' + hours.map((r) => `${String(r.h).padStart(2, '0')}h ${r.x}/${r.c}`).join('   '));
  console.log();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
