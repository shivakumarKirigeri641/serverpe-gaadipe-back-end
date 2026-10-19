/**
 * src/whatsapp/policy.js — THE POLICY GUARD (user, 2026-10-19: "they always pin point policy,
 * terms for messaging and thats why they disable, can you help me"). The account was disabled
 * after SCAM strikes (16–18 Oct) and once called ALCOHOL. Every WhatsApp message is read here,
 * at send.post(), the one door, for what Meta's WhatsApp Business and Commerce policies punish:
 *
 *   alcohol      Commerce Policy bans alcohol content: the words are replaced, never sent
 *   government   looking like a Government/VAHAN service (the fake e-challan scam)
 *   pressure     pay-or-else wording: fines, penalties, legal action, last chance
 *   credentials  asking for OTP, password, PIN, CVV, card or Aadhaar numbers
 *   link_token   a bare link with a long random code in it (a scam's favourite shape)
 *
 * Only alcohol is rewritten. The rest are warnings: the message still goes (a stopped reply is
 * worse than a word), the admin is told once a day per rule, and the hit is kept in event_log
 * (kind wa_policy_warn) so scripts/policy-audit.js can show what Meta saw. Fix the source.
 */

const ALCOHOL = /\b(drunk(en)?|alcohol(ic)?|liquor|intoxicat\w*|under the influence|influence of (drink|liquor|alcohol|drugs?))\b|\b(sharab|daru)\b|शराब|नशे/gi;

const RULES = [
  { id: 'government', re: /\b(government|govt\.?|vahan|parivahan|sarathi|ministry of road|morth|nic\.in|official (portal|website|site))\b/i,
    why: 'looks like a Government service (the fake e-challan scam)' },
  { id: 'pressure', re: /\b(avoid (fines?|penalt\w+)|pay (your|the) (challan|fine)s?|legal action|arrest|seiz(e|ure)|last chance|act now|immediately or|failing which)\b/i,
    why: 'pay-or-else pressure' },
  { id: 'credentials', re: /\b(otp|password|cvv|card number|aadhaa?r( number| no)?|upi pin|atm pin)\b/i,
    why: 'asks for a code or ID number', unless: /\bnever (ask|share|need)\w*/i },
  { id: 'link_token', re: /https?:\/\/\S*\/[A-Za-z0-9_-]{20,}/i,
    why: 'a bare link with a long random code' },
];

/** Every string a payload sends, except the links on buttons (those are meant to be links). */
function strings(payload) {
  const out = [];
  const walk = (v, key) => {
    if (typeof v === 'string') { if (key !== 'url' && key !== 'link') out.push(v); return; }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, key)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(payload, null);
  return out;
}

/** The rules a text breaks, as [{ id, why, sample }]. */
function check(text) {
  const s = String(text || '');
  const hits = [];
  for (const r of RULES) {
    const m = s.match(r.re);
    if (!m || (r.unless && r.unless.test(s))) continue;
    const at = Math.max(0, m.index - 30);
    hits.push({ id: r.id, why: r.why, sample: s.slice(at, m.index + m[0].length + 30).replace(/\s+/g, ' ') });
  }
  if (ALCOHOL.test(s)) hits.push({ id: 'alcohol', why: 'alcohol words (Commerce Policy)', sample: (s.match(ALCOHOL) || [''])[0] });
  ALCOHOL.lastIndex = 0;
  return hits;
}

/** The payload with alcohol words replaced, everywhere but in links. A new object; the input is untouched. */
function scrub(payload) {
  const fix = (v, key) => {
    if (typeof v === 'string') {
      if (key === 'url' || key === 'link') return v;
      const out = v.replace(ALCOHOL, 'Section 185 MV Act offence');
      ALCOHOL.lastIndex = 0;
      return out;
    }
    if (Array.isArray(v)) return v.map((x) => fix(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x, k)]));
    return v;
  };
  return fix(payload, null);
}

/**
 * At the door: returns the payload to send (alcohol words replaced) and, in the background,
 * records and reports any other rule it breaks. Never throws, never stops a message.
 */
function guard(payload, { mobile, type, templateName } = {}) {
  let clean = payload;
  try {
    const hits = strings(payload).flatMap(check);
    if (!hits.length) return payload;
    if (hits.some((h) => h.id === 'alcohol')) clean = scrub(payload);
    const warn = hits.filter((h) => h.id !== 'alcohol');
    const ids = [...new Set(hits.map((h) => h.id))];
    console.warn('[wa-policy] %s to ••%s: %s', templateName || type, String(mobile || '').slice(-4), ids.join(', '));
    const db = require('../db');
    db.query(`INSERT INTO event_log (kind, detail) VALUES ('wa_policy_warn', $1)`,
      [JSON.stringify({ mobile: `••${String(mobile || '').slice(-4)}`, type, template: templateName || null, hits })]).catch(() => {});
    if (warn.length) {
      const day = new Date().toISOString().slice(0, 10);
      for (const h of warn) {
        require('../util/adminPing').ping({
          key: `wa_policy:${h.id}:${day}`, severity: 'warning', source: 'whatsapp',
          title: `⚠️ WhatsApp wording risk: ${h.id}`,
          text: `A ${templateName || type} message held ${h.why}: “…${h.sample}…”. It was sent. Meta disables accounts for this; change the wording at its source. (Shown once a day per kind; all hits: node scripts/policy-audit.js)`,
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[wa-policy] guard failed (message sent unchanged):', e.message);
    return payload;
  }
  return clean;
}

module.exports = { guard, check, scrub, strings, RULES, ALCOHOL };
