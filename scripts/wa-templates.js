/**
 * scripts/wa-templates.js
 * ---------------------------------------------------------------------------
 * What Meta thinks of our message templates.
 *
 *   npm run wa:templates            every template on the account
 *   npm run wa:templates gp_        only ones whose name starts with gp_
 *   npm run wa:templates --promote  switch settings to any approved _pending
 *
 * WHY THIS EXISTS: a template's category is decided by Meta, not by us. A
 * template submitted as UTILITY can come back MARKETING, which costs about
 * seven times more per send and is subject to per-user frequency caps that drop
 * messages silently. That is worth seeing at a glance rather than discovering
 * from a bill.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const db = require('../src/db');

const V = process.env.WHATSAPP_API_VERSION || 'v21.0';
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WABA = process.env.WHATSAPP_BUSINESS_ID;

const args = process.argv.slice(2);
const promote = args.includes('--promote');
const filter = args.find(a => !a.startsWith('--')) || '';

const MARK = { APPROVED: 'ok      ', PENDING: 'PENDING ', REJECTED: 'REJECTED', PAUSED: 'PAUSED  ' };

(async () => {
  if (!TOKEN || !WABA) {
    console.error('\n  WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ID must be set in .env\n');
    process.exit(1);
  }

  const res = await fetch(
    `https://graph.facebook.com/${V}/${WABA}/message_templates`
    + '?limit=200&fields=name,status,category,language,rejected_reason',
    { headers: { Authorization: `Bearer ${TOKEN}` } });
  const json = await res.json();
  if (json.error) {
    console.error('\n  ' + json.error.message + '\n');
    process.exit(1);
  }

  const list = (json.data || [])
    .filter(t => t.name.startsWith(filter))
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log();
  for (const t of list) {
    console.log(`  ${MARK[t.status] || t.status}  ${t.category.padEnd(10)}${t.name}`
      + (t.rejected_reason && t.rejected_reason !== 'NONE' ? `   (${t.rejected_reason})` : ''));
  }
  console.log(`\n  ${list.length} template(s)\n`);

  // Which templates the bot is actually using, and what is waiting to replace
  // them. Names live in app_settings so a swap needs no deploy.
  const { rows } = await db.query(
    `SELECT key, value FROM app_settings WHERE key LIKE 'template%' ORDER BY key`);
  const inUse = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const statusOf = (name) => (list.find(t => t.name === name) || {}).status || 'not found';

  console.log('  in use:');
  for (const [k, v] of Object.entries(inUse)) {
    if (k.endsWith('_pending')) continue;
    const pendingKey = `${k}_pending`;
    const waiting = inUse[pendingKey];
    console.log(`    ${k.replace('template_', '').padEnd(16)} ${v} (${statusOf(v)})`
      + (waiting ? `   -> waiting on ${waiting} (${statusOf(waiting)})` : ''));
  }
  console.log();

  if (promote) {
    let moved = 0;
    for (const [k, v] of Object.entries(inUse)) {
      if (!k.endsWith('_pending')) continue;
      const live = k.replace('_pending', '');
      if (statusOf(v) !== 'APPROVED') continue;
      await db.query(`UPDATE app_settings SET value = $2 WHERE key = $1`, [live, v]);
      await db.query(`DELETE FROM app_settings WHERE key = $1`, [k]);
      console.log(`  promoted ${live} -> ${v}`);
      moved++;
    }
    console.log(moved ? '' : '  nothing approved to promote yet\n');
  }

  await db.close();
})().catch((e) => { console.error('\nfailed:', e.message, '\n'); process.exit(1); });
