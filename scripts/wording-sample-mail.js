/**
 * scripts/wording-sample-mail.js — WHAT A CHALLAN LOOKS LIKE ON EACH CHANNEL (user, 2026-10-20: "make a
 * script and send me a mail on challan with actual words, and how you hide and send the words avoiding
 * the violations; give me a sample; do not send to WhatsApp, all to mail").
 *
 * Builds a sample vehicle with real-world challan wording (drunk driving, "Government", "avoid fines"…)
 * and shows, side by side:
 *   1. each offence as the record has it  ->  in the EMAIL (full)  ->  on WhatsApp / website / PDF
 *   2. the WhatsApp report message exactly as it would leave the server (report.build + the policy guard)
 *   3. sentences GaadiPe used to send, before -> after the guard
 * Sends ONE email to the admin address (ADMINMAIL / admin_alert_emails). Nothing goes to WhatsApp:
 * this script never loads the WhatsApp sender. The guard's rewrite is used without its logging, so the
 * weekly policy audit is not affected.
 *
 *   node scripts/wording-sample-mail.js          email it
 *   node scripts/wording-sample-mail.js --dry    print it here instead
 */
require('dotenv').config();
const words = require('../src/util/safeWords');
const policy = require('../src/whatsapp/policy');
const report = require('../src/whatsapp/report');

const dry = process.argv.includes('--dry');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rupees = (p) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`;

// The sample vehicle — offences as e-Challan records really word them.
const challans = [
  { challan_date: '2026-09-02', place: 'MG Road, Bengaluru', amount_paise: 1000000, challan_no: 'KA1234567890',
    offence: 'Driving by a drunken person / under the influence of alcohol' },
  { challan_date: '2026-09-14', place: 'Silk Board Junction', amount_paise: 50000, challan_no: 'KA1234567891',
    offence: 'Over speeding; Driving without valid PUC' },
  { challan_date: '2026-10-01', place: 'Hebbal Flyover', amount_paise: 100000, challan_no: 'KA1234567892',
    offence: 'Using mobile phone while driving' },
];
const data = {
  vehicle_number: 'KA01AB1234', fetched_at: new Date().toISOString(),
  rc: { maker: 'MARUTI SUZUKI', model: 'SWIFT', insurance_upto: '2027-03-01', pucc_upto: '2026-10-28', tax_upto: '2035-01-01' },
  challans: { pending_count: challans.length, pending_amount_paise: challans.reduce((t, c) => t + c.amount_paise, 0),
              pending: challans, disposed_count: 1 },
};

// What WhatsApp would really send: the text, through the same rewrite the server applies at send time.
const onWhatsApp = (text) => policy.scrub({ type: 'text', text: { body: text } }).text.body;

const before = [
  'Namaste! 🙏 This is *GaadiPe* — Government vehicle records on WhatsApp.',
  '_Checked 25 Sep 2026 · Government records_',
  '⚠️ The Government vehicle records server is down.',
  'Always keep the documents updated to avoid fines.',
  'Pay your challan now on the official portal.',
  'Offence: Drunken driving · Driving under the influence of alcohol',
  'GaadiPe द्वारा VAHAN रिकॉर्ड से · शराब पीकर गाड़ी · सरकारी रिकॉर्ड',
];

(async () => {
  const waReport = onWhatsApp(report.build(data, { detailed: true,
    emailLine: '📧 The full challan details — offence, place and amount — are sent to your email (sh•••••@gmail.com).' }));

  // 1. offences
  const rows = challans.map((c) => ({ raw: c.offence, email: c.offence, other: words.offence(c.offence), place: c.place, amt: rupees(c.amount_paise) }));

  const td = 'style="border:1px solid #d5dbe5;padding:7px 9px;vertical-align:top;font-size:13px;"';
  const th = 'style="border:1px solid #d5dbe5;padding:7px 9px;background:#f3f6fb;text-align:left;font-size:12px;"';
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1a1f2b;max-width:760px;">
  <h2 style="margin:0 0 4px;color:#0b3d91;">Challan wording — what each channel shows</h2>
  <p style="margin:0 0 14px;color:#5b6475;">A sample vehicle (KA01AB1234) with real-world challan wording. Nothing was sent to WhatsApp — this email only.</p>

  <h3 style="color:#0b3d91;">1. Each offence, by channel</h3>
  <table style="border-collapse:collapse;width:100%;">
    <tr><th ${th}>As the record has it</th><th ${th}>📧 Email (full details)</th><th ${th}>💬 WhatsApp · website · PDF</th></tr>
    ${rows.map((r) => `<tr><td ${td}>${esc(r.raw)}<br><span style="color:#6b8380;">${esc(r.place)} · ${r.amt}</span></td>
      <td ${td}>${esc(r.email)}</td><td ${td}><b>${esc(r.other)}</b></td></tr>`).join('')}
  </table>
  <p style="font-size:12px;color:#5b6475;">WhatsApp messages never list offence names at all — only "2 pending · ₹X in total". The website and the PDF show the neutral names in the right column. Email shows the record's own words.</p>

  <h3 style="color:#0b3d91;">2. The WhatsApp report message, exactly as it would leave the server</h3>
  <pre style="white-space:pre-wrap;background:#f6faf9;border:1px solid #e3ecea;border-radius:8px;padding:12px;font-size:13px;line-height:1.5;">${esc(waReport)}</pre>

  <h3 style="color:#0b3d91;">3. Sentences GaadiPe used to send — before and after the guard</h3>
  <table style="border-collapse:collapse;width:100%;">
    <tr><th ${th}>Before (risky)</th><th ${th}>What WhatsApp sends now</th></tr>
    ${before.map((s) => `<tr><td ${td}>${esc(s)}</td><td ${td}><b>${esc(onWhatsApp(s))}</b></td></tr>`).join('')}
  </table>

  <h3 style="color:#0b3d91;">4. The rules</h3>
  <ul style="font-size:13px;line-height:1.6;">
    <li><b>Alcohol / drink-driving</b> → "Section 185 MV Act offence" (the same law, without the words).</li>
    <li><b>Government, Govt, VAHAN, Parivahan, सरकारी</b> → "vehicle records" / "our records source".</li>
    <li><b>Avoid fines, pay your challan, legal action, last chance</b> → calm wording ("stay on time", "see your challan details").</li>
    <li><b>Links</b> are never edited; they go as WhatsApp buttons.</li>
    <li><b>Email</b> keeps the full offence text; GaadiPe's own wording still never says "Government".</li>
  </ul>
  <p style="font-size:12px;color:#8a93a4;">Generated by scripts/wording-sample-mail.js · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p>
</div>`;

  const text = [
    'CHALLAN WORDING — WHAT EACH CHANNEL SHOWS (sample, nothing sent to WhatsApp)', '',
    '1. Each offence: record -> email -> WhatsApp/website/PDF',
    ...rows.map((r) => `- ${r.raw}\n    email: ${r.email}\n    WhatsApp/website/PDF: ${r.other}`), '',
    '2. The WhatsApp report message as it would leave the server:', waReport, '',
    '3. Before -> after:', ...before.map((s) => `- ${s}\n    -> ${onWhatsApp(s)}`),
  ].join('\n');

  // Confirm nothing risky is in what WhatsApp would send.
  const stillRisky = [waReport, ...before.map(onWhatsApp), ...rows.map((r) => r.other)].some((t) => words.risky(t));
  if (dry) { console.log(text); console.log('\nanything risky left on the WhatsApp side:', stillRisky); process.exit(0); }

  const out = await require('../src/mail/mailer').send({
    subject: `Challan wording sample — email vs WhatsApp${stillRisky ? ' (⚠️ something risky left)' : ' (✅ clean)'}`, html, text });
  console.log(out.ok ? `✅ Sent to ${out.to}` : `❌ ${out.error}`);
  console.log('Anything risky left on the WhatsApp side:', stillRisky);
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
