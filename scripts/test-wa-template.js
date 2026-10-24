/**
 * scripts/test-wa-template.js — SEND ONE APPROVED WHATSAPP TEMPLATE TO YOUR OWN NUMBER (user, 2026-10-24: "my
 * number is in the 24-hour window, send one to me to check"). See each template exactly as a customer would.
 *
 *   node scripts/test-wa-template.js 9886122415 report_ready   the report template, with your latest report's PDF
 *                                                              attached (or the sample report if you have none)
 *   node scripts/test-wa-template.js 9886122415 monitoring     the monitoring alert, sample values
 *   node scripts/test-wa-template.js 9886122415 renewal        the "monitoring ending soon" reminder, sample values
 *
 * ONLY to GaadiPe's own internal numbers (users.is_internal) — any other number is refused. The template name
 * comes from Settings (wa_template_report_ready / wa_template_monitoring / wa_template_renewal). Logged like any
 * WhatsApp message. Template messages are charged by Meta (Utility, a few paise each).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const settings = require('../src/util/settings');
const send = require('../src/whatsapp/send');

const [rawMobile, which] = process.argv.slice(2);
const mobile = String(rawMobile || '').replace(/\D/g, '').slice(-10);
const KINDS = {
  report_ready: { key: 'wa_template_report_ready', buttons: ['menu', 'check_another', 'my_reports'] },
  monitoring: { key: 'wa_template_monitoring', values: ['Ravi', 'KA01AB1234', 'Insurance', '29 Oct 2026', 'Expires in 7 days'],
    buttons: ['mon|t|0|exp|insurance', 'mon|c|0|exp|insurance', 'mon|p|0|exp|insurance'] },
  renewal: { key: 'wa_template_renewal', values: ['Ravi', 'KA01AB1234', '30 Oct 2026'],
    buttons: ['ren|r|KA01AB1234', 'ren|m|KA01AB1234', 'ren|n|KA01AB1234'] },
};

(async () => {
  const k = KINDS[which];
  if (mobile.length !== 10 || !k) {
    console.log('usage: node scripts/test-wa-template.js 9886122415 report_ready|monitoring|renewal');
    process.exit(1);
  }
  const own = await db.one(`SELECT id, coalesce(display_name, wa_profile_name, name) AS name FROM users
    WHERE right(regexp_replace(mobile, '[^0-9]', '', 'g'), 10) = $1 AND is_internal LIMIT 1`, [mobile]).catch(() => null);
  if (!own) { console.log(`Refused: ${mobile} is not one of GaadiPe's own (internal) numbers.`); process.exit(1); }
  const tpl = String(await settings.get(k.key, '') || '').trim();
  if (!tpl) { console.log(`No template set in ${k.key} — switch it on first.`); process.exit(1); }
  const language = await settings.get('wa_template_language', 'en');
  const opts = { language, buttons: k.buttons };
  let values = k.values;

  if (which === 'report_ready') {
    // Your latest report's PDF, else the website's sample report.
    const r = await db.one(`SELECT report_number, reg_no, pdf_path, valid_until FROM vehicle_reports
      WHERE user_id = $1 AND pdf_path IS NOT NULL ORDER BY id DESC LIMIT 1`, [own.id]).catch(() => null);
    const sample = path.join(__dirname, '..', '..', 'serverpe-gaadipe-front-end', 'public', 'sample-report.pdf');
    const file = r?.pdf_path && fs.existsSync(r.pdf_path) ? r.pdf_path : (fs.existsSync(sample) ? sample : null);
    if (!file) { console.log('No report PDF found for you, and no sample-report.pdf next to the back end.'); process.exit(1); }
    const fname = `${r?.report_number || 'GaadiPe-sample-report'}.pdf`;
    const up = await send.uploadPdf(file, fname);
    if (!up.ok) { console.log('Upload to Meta failed:', up.error); process.exit(1); }
    opts.headerDocument = { id: up.id, filename: fname };
    const day = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    values = [String(own.name || 'there').split(/\s+/)[0], r?.reg_no || 'KA01AB1234', r?.report_number || 'GP-RPT-SAMPLE',
      r?.valid_until ? day(r.valid_until) : day(Date.now() + 28 * 864e5)];
    console.log(`Attaching ${r ? `your report ${r.report_number}` : 'the sample report'}.`);
  }

  console.log(`Sending ${tpl} to ••••${mobile.slice(-4)} with: ${values.join(' | ')}`);
  const out = await send.template(mobile, tpl, values, opts);
  console.log(out.ok ? `✅ sent (${out.id || 'ok'}) — check WhatsApp.` : `❌ not sent: ${out.error}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
