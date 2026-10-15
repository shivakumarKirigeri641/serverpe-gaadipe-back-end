/**
 * scripts/test-sms.js — SEND ONE SMS-BROADCAST TEMPLATE TO ONE NUMBER (user, 2026-10-15: "one
 * script to test to my number"). Before sending a batch, see exactly what customers get.
 *
 *   node scripts/test-sms.js 9886122415                                  the latest template, sample values
 *   node scripts/test-sms.js 9886122415 "back on WhatsApp" "Tech issue fixed" "https://gaadipe.in"
 *   node scripts/test-sms.js 9886122415 --template 3 "v1" "v2" "v3"      a chosen template (its number in --list)
 *   node scripts/test-sms.js --list                                      the templates and their numbers
 *   add --dry to print what would go and send nothing
 *
 * Goes ONLY to the number given, through the same door as a broadcast (util/sms.sendTemplate):
 * its template's message id (the long DLT id is looked up as Fast2SMS's), its header, the
 * 10 am - 9 pm rule for promotional SMS, blocks. The opt-in to offers is skipped only when the
 * number is one of GaadiPe's own (internal) numbers. Logged like any SMS.
 */
require('dotenv').config();
const db = require('../src/db');
const S = require('../src/admin/smsBroadcast');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const dry = args.includes('--dry');
const list = args.includes('--list');
const tplKey = flag('--template');
const rest = args.filter((a) => !a.startsWith('--'));
const mobile = String(rest[0] || '').replace(/\D/g, '').slice(-10);

(async () => {
  if (list) {
    for (const t of await S.templates()) console.log(`${t.key}. ${t.name} — ${t.mode}, ${t.vars} value(s), header ${t.sender || 'MISSING'}, id ${t.id}`);
    process.exit(0);
  }
  if (mobile.length !== 10) {
    console.log('Usage: node scripts/test-sms.js <10-digit mobile> ["value 1" "value 2" "value 3"] [--template N] [--dry] | --list');
    process.exit(1);
  }
  const t = await S.template(tplKey);
  if (!t) { console.log(tplKey ? `No template ${tplKey} — see --list.` : 'No template yet — add one on the SMS broadcast page.'); process.exit(1); }

  const SAMPLE = ['back on WhatsApp', 'Tech issue fixed', 'https://gaadipe.in'];
  const slots = String(t.text).match(/\{#[a-z_]+#\}/gi) || [];
  const values = slots.map((s, i) => rest[i + 1] || (/url/i.test(s) ? 'https://gaadipe.in' : SAMPLE[i] || 'test'));
  const long = values.findIndex((v) => v.length > 30);
  const text = S.fill(t.text, values);
  const size = S.smsLength(text);

  const user = await db.one(`SELECT id, is_internal, promo_consent_at IS NOT NULL AND promo_consent_withdrawn_at IS NULL AS opted
                               FROM users WHERE right(regexp_replace(mobile, '\\D', '', 'g'), 10) = $1`, [mobile]);
  console.log(`Template : ${t.name} (${t.mode}) · header ${t.sender || 'MISSING'} · id ${t.id}`);
  console.log(`To       : ${mobile}${user ? (user.is_internal ? ' · internal (yours)' : '') + (user.opted ? ' · opted in' : ' · not opted in') : ' · not a customer'}`);
  console.log(`Values   : ${values.map((v) => `"${v}"`).join('  ') || '(none)'}`);
  console.log(`Message  : ${size.length}/${size.limit} characters${size.unicode ? ' (Unicode)' : ''}\n---\n${text}\n---`);
  if (long >= 0) { console.log(`Value ${long + 1} is over 30 characters — DLT would cut it. Shorten it.`); process.exit(1); }
  if (size.length > size.limit) { console.log('Too long for one SMS.'); process.exit(1); }
  if (t.mode === 'promo' && user && !user.opted && !user.is_internal) {
    console.log('This number has not opted in to offers, so a promotional SMS will not go to it. Test with your own number.');
    process.exit(1);
  }
  if (dry) { console.log('--dry: nothing sent.'); process.exit(0); }

  const out = await require('../src/util/sms').sendTemplate(t.mode, mobile, values, { templateId: Number(t.key), test: true });
  console.log(out.ok ? (out.simulated ? 'Simulated — no SMS provider on this machine.' : `Sent ✓ (Fast2SMS request ${out.id || '—'}). It should arrive within a minute.`)
    : `Not sent: ${out.error}`);
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
