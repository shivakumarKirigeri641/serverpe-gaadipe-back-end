/**
 * src/whatsapp/policy.js — THE POLICY GUARD (user, 2026-10-19: "they always pin point policy,
 * terms for messaging and thats why they disable, can you help me"). The account was disabled
 * after SCAM strikes (16–18 Oct) and once called ALCOHOL. Every WhatsApp message is read here,
 * at send.post(), the one door, for what Meta's WhatsApp Business and Commerce policies punish.
 *
 * REWRITTEN, NEVER SENT (user, 2026-10-20: "'Government', 'Alcohol', scam such wording must never
 * be present"): util/safeWords.clean() rewrites, in every text of the message but its links —
 *   alcohol      drink-driving offence names
 *   government   Government / VAHAN / Parivahan / Sarathi / सरकारी
 *   pressure     avoid fines, pay your challan, legal action, last chance, act now
 * WARNED (cannot be rewritten without changing what the message means; fix the source):
 *   credentials  asking for OTP, password, PIN, CVV, card or Aadhaar numbers
 *   link_token   a bare link with a long random code in it (a scam's favourite shape)
 *   threat       arrest, seize
 * The message still goes (a stopped reply is worse than a word); every hit is kept in event_log
 * (kind wa_policy_warn) and the admin is told once a day per kind. scripts/policy-audit.js
 * shows them all.
 */

const words = require('../util/safeWords');

const WARN = [
  { id: 'credentials', re: /\b(otp|password|cvv|card number|aadhaa?r( number| no)?|upi pin|atm pin)\b/i,
    why: 'asks for a code or ID number', unless: /\bnever (ask|share|need)\w*/i },
  { id: 'link_token', re: /https?:\/\/\S*\/[A-Za-z0-9_-]{20,}/i,
    why: 'a bare link with a long random code' },
  { id: 'threat', re: /\b(arrest\w*|seiz(e|ed|ure))\b/i, why: 'threat wording' },
  // A link is never edited, so a government site's address is reported instead (2026-10-20).
  { id: 'gov_link', re: /https?:\/\/[^\s/]*\.(gov|nic)\.in/i, why: 'a link to a government website' },
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

/** What a text holds, as [{ id, why, sample }]: the rewritten kinds and the warned ones. */
function check(text) {
  const s = String(text || '');
  const hits = [];
  for (const r of words.RULES) {
    const m = s.match(r.re); r.re.lastIndex = 0;
    if (!m) continue;
    hits.push({ id: r.kind, why: 'rewritten before sending', sample: m[0] });
  }
  for (const r of WARN) {
    const m = s.match(r.re);
    if (!m || (r.unless && r.unless.test(s))) continue;
    const at = Math.max(0, m.index - 30);
    hits.push({ id: r.id, why: r.why, warn: true, sample: s.slice(at, m.index + m[0].length + 30).replace(/\s+/g, ' ') });
  }
  return hits;
}

/** The payload with every text cleaned, links untouched. A new object; the input is untouched. */
function scrub(payload) {
  const fix = (v, key) => {
    if (typeof v === 'string') return key === 'url' || key === 'link' ? v : words.clean(v);
    if (Array.isArray(v)) return v.map((x) => fix(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x, k)]));
    return v;
  };
  return fix(payload, null);
}

/**
 * At the door: returns the payload to send, cleaned, and in the background records and reports
 * what it held. Never throws, never stops a message.
 */
function guard(payload, { mobile, type, templateName } = {}) {
  try {
    const hits = strings(payload).flatMap(check);
    if (!hits.length) return payload;
    const clean = scrub(payload);
    const ids = [...new Set(hits.map((h) => h.id))];
    console.warn('[wa-policy] %s to ••%s: %s', templateName || type, String(mobile || '').slice(-4), ids.join(', '));
    const db = require('../db');
    db.query(`INSERT INTO event_log (kind, detail) VALUES ('wa_policy_warn', $1)`,
      [JSON.stringify({ mobile: `••${String(mobile || '').slice(-4)}`, type, template: templateName || null, hits })]).catch(() => {});
    const day = new Date().toISOString().slice(0, 10);
    for (const h of hits.filter((x) => x.warn)) {
      require('../util/adminPing').ping({
        key: `wa_policy:${h.id}:${day}`, severity: 'warning', source: 'whatsapp',
        title: `⚠️ WhatsApp wording risk: ${h.id}`,
        text: `A ${templateName || type} message held ${h.why}: “…${h.sample}…”. It was sent. Meta disables accounts for this; change the wording at its source. (Shown once a day per kind; all hits: node scripts/policy-audit.js)`,
      }).catch(() => {});
    }
    return clean;
  } catch (e) {
    console.error('[wa-policy] guard failed (message sent unchanged):', e.message);
    return payload;
  }
}

module.exports = { guard, check, scrub, strings, WARN };
