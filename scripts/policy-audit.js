/**
 * scripts/policy-audit.js — WHAT DID META SEE? (user, 2026-10-19: "they always pin point
 * policy, terms for messaging"). Read-only, sends nothing. Reads the WhatsApp messages GaadiPe
 * sent (whatsapp_messages, direction out) against the policy guard's rules
 * (src/whatsapp/policy.js) and prints, per rule, how many messages broke it and a few samples.
 * Also: templates sent to people who had not written in that day, and blocks/reports.
 *
 *   node scripts/policy-audit.js            last 30 days
 *   node scripts/policy-audit.js --days 7
 */
require('dotenv').config();
const db = require('../src/db');
const policy = require('../src/whatsapp/policy');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const DAYS = Math.max(1, Number(arg('--days', 30)) || 30);
const tail = (m) => `••${String(m || '').slice(-4)}`;

(async () => {
  const { rows } = await db.query(
    `SELECT id, mobile, message_type, template_name, body, payload, created_at
       FROM whatsapp_messages
      WHERE direction = 'out' AND error_message IS NULL AND created_at > now() - make_interval(days => $1)
      ORDER BY id`, [DAYS]);
  console.log(`WhatsApp messages sent in the last ${DAYS} days: ${rows.length}\n`);

  const byRule = new Map();
  for (const r of rows) {
    const hits = policy.strings(r.payload || r.body).flatMap(policy.check);
    for (const h of hits) {
      const b = byRule.get(h.id) || { why: h.why, count: 0, kinds: new Map(), samples: [], days: new Map() };
      b.count += 1;
      const kind = r.template_name ? `template ${r.template_name}` : r.message_type;
      const day = new Date(r.created_at).toISOString().slice(0, 10);
      b.kinds.set(kind, (b.kinds.get(kind) || 0) + 1);
      b.days.set(day, (b.days.get(day) || 0) + 1);
      // The newest samples (rows come oldest first): what is still going out matters most.
      b.samples.push(`${day} ${tail(r.mobile)} ${kind}: “…${h.sample}…”`);
      if (b.samples.length > 4) b.samples.shift();
      byRule.set(h.id, b);
    }
  }
  if (!byRule.size) console.log('No risky wording found.');
  for (const [id, b] of byRule) {
    console.log(`■ ${id} — ${b.why}: ${b.count} message(s)`);
    console.log(`   from: ${[...b.kinds].sort((a, c) => c[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ')}`);
    console.log(`   last 7 days with hits: ${[...b.days].slice(-7).map(([d, n]) => `${d.slice(5)} ×${n}`).join(', ')}`);
    console.log('   newest:');
    for (const s of b.samples) console.log(`   ${s}`);
    console.log('');
  }

  // Templates are the messages Meta judges hardest: started by GaadiPe, to someone who did not write that day.
  const t = await db.query(
    `SELECT template_name, count(*)::int AS n, count(DISTINCT mobile)::int AS people
       FROM whatsapp_messages
      WHERE direction = 'out' AND message_type = 'template' AND error_message IS NULL
        AND created_at > now() - make_interval(days => $1)
      GROUP BY 1 ORDER BY 2 DESC`, [DAYS]);
  console.log('Templates sent (GaadiPe started the chat):');
  for (const r of t.rows) console.log(`   ${r.template_name}: ${r.n} to ${r.people} people`);
  if (!t.rows.length) console.log('   none');

  // Day by day: a broadcast burst, and the same people getting the same template again, show here.
  const daily = await db.query(
    `SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, template_name,
            count(*)::int AS n, count(DISTINCT mobile)::int AS people
       FROM whatsapp_messages
      WHERE direction = 'out' AND message_type = 'template' AND error_message IS NULL
        AND created_at > now() - make_interval(days => $1)
      GROUP BY 1, 2 ORDER BY 1, 3 DESC`, [DAYS]);
  console.log('\nTemplates by day (IST):');
  for (const r of daily.rows) console.log(`   ${r.day}  ${r.template_name}: ${r.n} to ${r.people} people`);

  const again = await db.query(
    `SELECT template_name, times, count(*)::int AS people FROM (
       SELECT template_name, mobile, count(*)::int AS times FROM whatsapp_messages
        WHERE direction = 'out' AND message_type = 'template' AND error_message IS NULL
          AND created_at > now() - make_interval(days => $1)
        GROUP BY 1, 2) x
      WHERE times > 1 GROUP BY 1, 2 ORDER BY 1, 2`, [DAYS]);
  console.log('\nSame template to the same person more than once:');
  for (const r of again.rows) console.log(`   ${r.template_name}: ${r.people} people got it ${r.times} times`);
  if (!again.rows.length) console.log('   none');

  // The approved wording of each template sent, as GaadiPe last saw it.
  const words = await db.query(
    `SELECT DISTINCT ON (template_name) template_name, payload FROM whatsapp_messages
      WHERE direction = 'out' AND message_type = 'template' AND created_at > now() - make_interval(days => $1)
      ORDER BY template_name, id DESC`, [DAYS]).catch(() => ({ rows: [] }));
  console.log('\nWhat each template carried (its variables, latest send):');
  for (const r of words.rows) console.log(`   ${r.template_name}: ${policy.strings(r.payload).filter((s) => s.length > 2 && s !== r.template_name && !/^\d{10,}$/.test(s)
      && !/^(whatsapp|template|individual|body|button|quick_reply|text|en|hi|en_US)$/.test(s)).join(' | ').slice(0, 300)}`);

  const blocked = await db.query(
    `SELECT count(*)::int AS n FROM whatsapp_messages
      WHERE direction = 'out' AND created_at > now() - make_interval(days => $1)
        AND error_message ~ '131049|131048|131026|block'`, [DAYS]);
  console.log(`\nSends Meta refused for spam/blocking reasons: ${blocked.rows[0].n}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
