/**
 * scripts/tag-make.js — MAKE GAADIPE TAGS AND THEIR PRINT SHEET (user, 2026-10-29: "I have 3 vehicles … give me the
 * stickers in PDF, I will print and attach"). The same as the admin's GaadiPe Tag → Tags → "Make tags".
 *
 *   node scripts/tag-make.js 9886122415:KA02EX1480,KA31N8147 9900970271:KA32R8604
 *   node scripts/tag-make.js 9886122415:KA02EX1480 --copies 1
 *
 * Each mobile:vehicles pair: the customer (added if new), their vehicles marked as theirs (no provider lookup — the
 * number only), a tag for each (the live one kept), and the mobile on tag_allow_mobiles while tags are hidden. Then ONE
 * A4 print sheet with every tag, 2 copies each (rear windscreen + a side window), four cards to a page. Prints the path.
 */
require('dotenv').config();
const db = require('../src/db');

const args = process.argv.slice(2);
const copiesAt = args.indexOf('--copies');
const copies = copiesAt >= 0 ? Number(args[copiesAt + 1]) || 2 : 2;
const pairs = args.filter((a, i) => a.includes(':') && i !== copiesAt + 1);

(async () => {
  if (!pairs.length) {
    console.log('Usage: node scripts/tag-make.js <mobile>:<REG>[,<REG>…] [<mobile>:<REG>…] [--copies 2]');
    process.exit(1);
  }
  const A = require('../src/tags/admin');
  const T = require('../src/tags/tags');
  const codes = [];
  for (const p of pairs) {
    const [mobile, regs] = p.split(':');
    const out = await A.create({ mobile, regs: regs.split(','), allow: true });
    if (!out.ok) { console.error(`✗ ${p}: ${out.error}`); continue; }
    for (const t of out.tags) {
      codes.push(t.code);
      console.log(`✓ ${t.reg_no.padEnd(11)} → tag ${t.code} (${t.created ? 'new' : 'already there'}) · owner ••${out.mobile.slice(-4)} · ${T.tagUrl(t.code)}`);
    }
  }
  if (!codes.length) { console.error('No tags made.'); process.exit(1); }
  const file = await A.sheet(codes.join(','), copies);
  console.log(`\nPrint sheet (A4, ${copies} of each, 4 per page): ${file}`);
  console.log('Download it from the admin too: GaadiPe Tag → Tags → tick them → "Print sheet".\n');
  await db.close();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
