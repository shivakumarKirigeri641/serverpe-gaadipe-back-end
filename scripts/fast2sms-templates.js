/**
 * scripts/fast2sms-templates.js — WHAT FAST2SMS'S DLT MANAGER HOLDS (user, 2026-10-15: test SMS
 * refused "Invalid Message ID"). Read-only: lists the headers and templates Fast2SMS knows for this
 * account, so the Message ID a template needs can be read off instead of guessed. Sends nothing.
 *
 *   node scripts/fast2sms-templates.js            templates
 *   node scripts/fast2sms-templates.js sender     headers (sender ids)
 *   node scripts/fast2sms-templates.js --raw      the answer exactly as Fast2SMS gave it
 */
require('dotenv').config();

const type = process.argv.includes('sender') ? 'sender' : 'template';
const raw = process.argv.includes('--raw');
const key = process.env.FAST2SMSAPIKEY || process.env.FAST2SMS_API_KEY || '';

(async () => {
  if (!key) { console.log('No Fast2SMS key in .env (FAST2SMSAPIKEY).'); process.exit(1); }
  const res = await fetch(`https://www.fast2sms.com/dev/dlt_manager?type=${type}&authorization=${encodeURIComponent(key)}`,
    { headers: { authorization: key }, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  console.log(`HTTP ${res.status}`);
  if (raw || !body) { console.log(body ? JSON.stringify(body, null, 2) : text.slice(0, 3000)); process.exit(0); }

  // Every entry that looks like a template or a header, whatever the nesting.
  const rows = [];
  const walk = (x, parent = {}) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach((y) => walk(y, parent)); return; }
    const flat = Object.fromEntries(Object.entries(x).filter(([, v]) => v == null || typeof v !== 'object'));
    if (Object.keys(flat).some((k) => /message|template|sender/i.test(k))) rows.push({ ...parent, ...flat });
    Object.values(x).forEach((v) => { if (v && typeof v === 'object') walk(v, { ...parent, ...flat }); });
  };
  walk(body);
  if (!rows.length) { console.log('Nothing listed. The full answer:'); console.log(JSON.stringify(body, null, 2)); process.exit(0); }
  for (const r of rows) {
    console.log('---');
    for (const [k, v] of Object.entries(r)) console.log(`${k.padEnd(16)} ${String(v ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  console.log(`---\n${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}. The id the SMS broadcast needs is the one Fast2SMS calls the Message ID.`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
