/**
 * scripts/sample-report-hi.js — the sample report, in Hindi.
 *
 *   node scripts/sample-report-hi.js [path/to/sample-report-hi.pdf]
 *
 * WHY A BROWSER PRINTS THIS ONE: pdfkit cannot shape Devanagari — the vowel
 * signs land on the wrong side of their consonants and conjuncts fall apart —
 * so a Hindi report drawn the way the English one is would be wrong on every
 * line. A browser shapes Hindi properly, so the page is laid out in HTML with
 * Noto Sans Devanagari and printed to PDF by the Edge (or Chrome) already on
 * this machine, through playwright-core. Nothing is downloaded.
 *
 * Same invented data as the English sample (scripts/sample-report.js), the same
 * sections in the same order, and the same SAMPLE marking — it will be
 * forwarded away from the page that explains it. Government values (make,
 * model, RTO, offence) stay as the record has them, as they do on the site.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const db = require('../src/db');
const { DATA } = require('./sample-report');

const out = process.argv[2]
  || path.join(__dirname, '..', '..', 'serverpe-gaadipe-front-end', 'public', 'sample-report-hi.pdf');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MONTHS = ['जन॰', 'फ़र॰', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अग॰', 'सित॰', 'अक्टू॰', 'नव॰', 'दिस॰'];
const date = (v) => {
  if (!v) return '—';
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00+05:30`);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const rupees = (p) => `₹${(Number(p || 0) / 100).toLocaleString('en-IN')}`;
const daysFrom = (v) => Math.round((new Date(`${String(v).slice(0, 10)}T23:59:59+05:30`) - Date.now()) / 86400000);
const state = (v) => {
  if (!v) return { cls: 'none', word: 'दर्ज नहीं', note: '' };
  const d = daysFrom(v);
  if (d < 0) return { cls: 'bad', word: 'समाप्त', note: `${-d} दिन पहले समाप्त` };
  if (d <= 30) return { cls: 'soon', word: 'जल्द समाप्त', note: `${d} दिन बाकी` };
  return { cls: 'ok', word: 'वैध', note: `${d} दिन बाकी` };
};

function html(business) {
  const rc = DATA.rc;
  const c = DATA.challans;
  const docs = [
    ['बीमा', [rc.insurance_company, rc.insurance_policy].filter(Boolean).join(' · '), rc.insurance_upto],
    ['प्रदूषण (PUC)', rc.pucc_number, rc.pucc_upto],
    ['रोड टैक्स', '', rc.tax_upto],
    ['फ़िटनेस', '', rc.fitness_upto],
    ['परमिट', '', rc.permit_upto],
    ['पंजीकरण (RC)', '', rc.reg_upto],
  ];
  const attention = docs.map(([k, , v]) => [k, state(v)]).filter(([, s]) => s.cls === 'bad' || s.cls === 'soon');
  const issued = new Date();
  const issuedText = `${date(issued.toISOString())}, ${issued.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST`;

  const row = (k, v) => `<tr><th>${k}</th><td>${v ?? '—'}</td></tr>`;
  const challanRows = (list) => list.map((x) => `
    <tr><td class="n">${date(x.challan_date)}</td><td class="mono">${esc(x.challan_no)}</td>
        <td>${esc(x.offence)}<div class="muted">${esc(x.place)}</div></td><td class="r n">${rupees(x.amount_paise)}</td></tr>`).join('');

  return `<!doctype html><html lang="hi"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;600;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 14mm 13mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Noto Sans Devanagari', 'Inter', sans-serif; color: #0b1f1c; font-size: 10.5pt; line-height: 1.5; margin: 0; }
  .n, .mono, .plate { font-family: 'Inter', 'Noto Sans Devanagari', sans-serif; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 9pt; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0f766e; padding-bottom: 10px; }
  .brand { font-family: Inter; font-size: 20pt; font-weight: 700; color: #0f766e; letter-spacing: -.5px; }
  .brand small { display: block; font-family: 'Noto Sans Devanagari'; font-size: 9pt; font-weight: 400; color: #6b8380; letter-spacing: 0; }
  .meta { text-align: right; font-size: 8.5pt; color: #41514e; }
  .meta b { color: #0b1f1c; }
  .band { margin: 10px 0; padding: 6px 10px; background: #fff6e6; border: 1px solid #e0870055; color: #8f5600; font-weight: 600; font-size: 9pt; border-radius: 6px; }
  .hero { display: flex; gap: 16px; align-items: center; margin: 12px 0 6px; }
  .plate { border: 2px solid #111; border-radius: 6px; padding: 4px 12px; font-size: 18pt; font-weight: 800; letter-spacing: 2px; background: #fff; }
  .hero h1 { margin: 0; font-size: 14pt; }
  .hero p { margin: 0; color: #6b8380; font-size: 9pt; }
  h2 { font-size: 11.5pt; margin: 16px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #e3ecea; color: #0b4f4a; }
  table { width: 100%; border-collapse: collapse; }
  .kv th { width: 38%; text-align: left; font-weight: 400; color: #6b8380; padding: 4px 6px; border-bottom: 1px solid #eef3f2; }
  .kv td { padding: 4px 6px; border-bottom: 1px solid #eef3f2; font-weight: 600; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
  .list th { text-align: left; font-size: 8.5pt; font-weight: 600; color: #6b8380; background: #f3f8f7; padding: 5px 6px; }
  .list td { padding: 5px 6px; border-bottom: 1px solid #eef3f2; vertical-align: top; }
  .r { text-align: right; }
  .muted { color: #6b8380; font-size: 8.5pt; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 8.5pt; font-weight: 600; }
  .bad { background: #fdecec; color: #912018; } .soon { background: #fff6e6; color: #8f5600; }
  .ok { background: #e9f8ef; color: #0a6c34; } .none { background: #f3f8f7; color: #6b8380; }
  .alert { border: 1.5px solid #d92d2055; background: #fdecec; border-radius: 8px; padding: 8px 12px; margin: 8px 0; }
  .alert b { color: #912018; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 8px 0; }
  .tile { border: 1px solid #e3ecea; border-radius: 8px; padding: 7px 10px; }
  .tile .k { font-size: 8pt; color: #6b8380; } .tile .v { font-family: Inter; font-weight: 700; font-size: 13pt; }
  .consent { margin-top: 16px; border: 1px solid #e3ecea; border-radius: 8px; padding: 10px 12px; background: #f9fbfb; font-size: 8.8pt; color: #41514e; }
  .consent b { color: #0b1f1c; }
  .foot { margin-top: 14px; font-size: 8pt; color: #6b8380; border-top: 1px solid #e3ecea; padding-top: 8px; }
  .avoid { break-inside: avoid; }
</style></head><body>

<div class="head">
  <div class="brand">GaadiPe<small>हर गाड़ी की कुंडली · वाहन रिपोर्ट</small></div>
  <div class="meta">रिपोर्ट संख्या <b>SAMPLE</b><br>जारी: <b>${issuedText}</b><br>स्रोत: सरकारी रिकॉर्ड (VAHAN, e-Challan, FASTag)</div>
</div>

<div class="band">नमूना — यह एक उदाहरण रिपोर्ट है। वाहन नंबर, चालान और पॉलिसी नंबर काल्पनिक हैं, किसी असली वाहन के नहीं।</div>

<div class="hero">
  <span class="plate">${esc(DATA.vehicle_number)}</span>
  <div><h1>${esc(rc.maker)} · ${esc(rc.model)}</h1>
  <p>${esc(rc.fuel)} · ${esc(rc.vehicle_class)} · निर्माण ${esc(rc.manufactured)} · ${esc(rc.registered_at)}</p></div>
</div>

${attention.length ? `<div class="alert"><b>ध्यान दें:</b> ${attention.map(([k, s]) => `${k} — ${s.word} (${s.note})`).join(' · ')}.
  ${c.pending_count ? ` ${c.pending_count} चालान बाकी, कुल ${rupees(c.pending_amount_paise)}.` : ''}</div>` : ''}

<div class="tiles">
  <div class="tile"><div class="k">RC स्थिति</div><div class="v">${rc.status === 'Active' ? 'सक्रिय' : esc(rc.status)}</div></div>
  <div class="tile"><div class="k">मालिक क्रम</div><div class="v">${rc.owner_serial}</div></div>
  <div class="tile"><div class="k">बाकी चालान</div><div class="v">${c.pending_count}</div></div>
  <div class="tile"><div class="k">बाकी जुर्माना</div><div class="v">${rupees(c.pending_amount_paise)}</div></div>
</div>

<h2>दस्तावेज़ और उनकी वैधता</h2>
<table class="list avoid"><thead><tr><th>दस्तावेज़</th><th>नंबर / कंपनी</th><th>कब तक वैध</th><th>स्थिति</th></tr></thead><tbody>
${docs.map(([k, detail, v]) => { const s = state(v); return `<tr><td><b>${k}</b></td><td>${esc(detail) || '—'}</td>
  <td class="n">${date(v)}${s.note ? `<div class="muted">${s.note}</div>` : ''}</td><td><span class="chip ${s.cls}">${s.word}</span></td></tr>`; }).join('')}
</tbody></table>

<div class="grid avoid">
  <div><h2>वाहन</h2><table class="kv">
    ${row('निर्माता', esc(rc.maker))}${row('मॉडल', esc(rc.model))}${row('श्रेणी', esc(rc.vehicle_class))}
    ${row('ईंधन', esc(rc.fuel))}${row('रंग', esc(rc.colour))}${row('इंजन', `${rc.cubic_capacity} cc`)}
    ${row('सीटें', rc.seats)}${row('उत्सर्जन मानक', esc(rc.norms))}${row('निर्माण', esc(rc.manufactured))}
  </table></div>
  <div><h2>पंजीकरण और स्वामित्व</h2><table class="kv">
    ${row('पंजीकरण संख्या', `<span class="n">${esc(rc.reg_no)}</span>`)}${row('RTO', esc(rc.registered_at))}
    ${row('पंजीकरण तिथि', date(rc.reg_date))}${row('मालिक क्रम', `${rc.owner_serial}वाँ मालिक`)}
    ${row('मालिक का प्रकार', rc.owner_type === 'Individual' ? 'व्यक्तिगत' : esc(rc.owner_type))}
    ${row('लोन / फ़ाइनेंसर', esc(rc.financer) || 'कोई नहीं')}${row('ब्लैकलिस्ट', rc.blacklist_status ? esc(rc.blacklist_status) : 'कुछ दर्ज नहीं')}
    ${row('NOC', rc.noc_details ? esc(rc.noc_details) : 'जारी नहीं')}
  </table><p class="muted">मालिक का नाम इस रिपोर्ट में नहीं दिखाया जाता।</p></div>
</div>

<h2>बाकी चालान (${c.pending_count}) · कुल ${rupees(c.pending_amount_paise)}</h2>
<table class="list"><thead><tr><th>तारीख</th><th>चालान नंबर</th><th>अपराध · स्थान</th><th class="r">राशि</th></tr></thead>
<tbody>${challanRows(c.pending)}</tbody></table>
<p class="muted">हर चालान नंबर पूरा है और e-Challan पोर्टल पर खोजा जा सकता है।</p>

<h2>भुगतान किए / निपटाए गए चालान (${c.disposed_count})</h2>
<table class="list"><thead><tr><th>तारीख</th><th>चालान नंबर</th><th>अपराध · स्थान</th><th class="r">राशि</th></tr></thead>
<tbody>${challanRows(c.disposed)}</tbody></table>

<h2>FASTag</h2>
<table class="kv avoid">${(DATA.fastag.tags || []).map((t) => `
  ${row('स्थिति', t.status === 'ACTIVE' ? '<span class="chip ok">सक्रिय</span>' : esc(t.status))}
  ${row('जारी करने की तारीख', date(t.issue_date))}${row('वाहन वर्ग', esc(t.vehicle_class))}
  ${row('व्यावसायिक', t.commercial ? 'हाँ' : 'नहीं')}`).join('')}
</table>

<div class="consent avoid">
  <b>घोषणा और सहमति।</b> यह रिपोर्ट उस ग्राहक के अनुरोध पर बनी है जिसने पुष्टि की कि यह वाहन उनका है, या इसके मालिक को वे जानते हैं,
  और वे इसकी जानकारी एक वैध उद्देश्य के लिए माँग रहे हैं। असली रिपोर्ट में यहाँ घोषणा का संदर्भ नंबर, समय, और स्वीकार की गई
  सेवा की शर्तों, गोपनीयता नीति और रिफ़ंड नीति के संस्करण छपे होते हैं। मालिक का नाम नहीं दिखाया जाता और दस्तावेज़ नंबर आंशिक रूप से छिपाए जाते हैं।
</div>

<div class="foot">
  GaadiPe सरकारी रिकॉर्ड को जैसा है वैसा दिखाता है और उसे बदल नहीं सकता; अगर कुछ आपके कागज़ों से अलग हो, तो RTO का रिकॉर्ड ही मान्य है।
  यह रिपोर्ट जारी होने के दिन के रिकॉर्ड दिखाती है और सात दिन तक डाउनलोड की जा सकती है। कानूनी रूप से अंग्रेज़ी संस्करण मान्य है।<br>
  ${esc(business.business_name || 'ServerPe App Solutions')}${business.gstin ? ` · GSTIN ${esc(business.gstin)}` : ''}${business.address ? ` · ${esc(business.address)}` : ''} · support@gaadipe.in
</div>
</body></html>`;
}

(async () => {
  let browser;
  try {
    const business = await db.one(
      `SELECT * FROM business_details WHERE is_active ORDER BY id DESC LIMIT 1`).catch(() => null) || {};

    // Edge ships with Windows; Chrome is the fallback elsewhere.
    for (const channel of ['msedge', 'chrome']) {
      try { browser = await chromium.launch({ channel }); break; } catch { /* try the next */ }
    }
    if (!browser) throw new Error('Neither Edge nor Chrome could be started.');

    const page = await browser.newPage();
    const markup = html(business);
    // SAMPLE_HTML=path also keeps the page itself, for checking the layout by eye.
    if (process.env.SAMPLE_HTML) fs.writeFileSync(process.env.SAMPLE_HTML, markup);
    await page.setContent(markup, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: 'A4', printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;font-size:7pt;color:#6b8380;padding:0 13mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>GaadiPe · SAMPLE</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    });

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, pdf);
    console.log(`\n  Hindi sample report written to ${out} (${(pdf.length / 1024).toFixed(0)} KB)\n`);
    await browser.close();
    process.exit(0);
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    console.error('\n  failed:', e.message, '\n');
    process.exit(1);
  }
})();
