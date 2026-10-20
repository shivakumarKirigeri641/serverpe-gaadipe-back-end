/**
 * src/util/safeWords.js — WORDS THAT NEVER GO OUT (user, 2026-10-20: "make sure contents like
 * 'Government', 'Alcohol', scam such wording must never be present"). Meta disabled GaadiPe's
 * WhatsApp for SCAM (9 strikes, 13–18 Oct) and once called it ALCOHOL: messages looked like the
 * fake e-challan scam — "Government records", "pay your challan", "avoid fines".
 *
 * clean(text) rewrites, never blocks:
 *   alcohol      drink-driving offence names → "Section 185 MV Act offence" (as the PDF does)
 *   government   Government / Govt / VAHAN / Parivahan / Sarathi / सरकारी → "vehicle records" and the like
 *   pressure     avoid fines, pay your challan, legal action, last chance, act now → calm words
 * Links are left exactly as they are (a URL is never edited). The rules are ordered: the
 * longest phrases first, so "Government vehicle records server" reads "our vehicle records source".
 *
 * Used at WhatsApp's one door (whatsapp/policy.js). The website, emails and PDFs are written
 * without these words at their source; scripts/policy-audit.js finds any that slip back in.
 */

// Each rule: what it finds, what it becomes, and its kind (alcohol / government / pressure).
let kind = 'alcohol';
const R = (re, to) => ({ re, to, kind });
const as = (k) => { kind = k; return null; };

const RULES = [
  // Alcohol — whole offence phrases first, then single words.
  R(/\b(?:drunk(?:en)?|drink)[\s-]*(?:and[\s-]*)?driv\w*/gi, 'Section 185 MV Act offence'),
  R(/\bdriv\w*\s+(?:while\s+)?(?:drunk(?:en)?|intoxicated|under the influence(?: of (?:drink|liquor|alcohol|drugs?))?)/gi, 'Section 185 MV Act offence'),
  R(/\b(?:under the influence(?: of (?:drink|liquor|alcohol|drugs?))?|influence of (?:drink|liquor|alcohol|drugs?))\b/gi, 'Section 185 MV Act offence'),
  R(/\b(?:drunk(?:en)?|alcohol(?:ic)?|liquor|intoxicat\w*)\b|\b(?:sharab|daru)\b|शराब|नशे/gi, 'Section 185 offence'),

  as('government'),
  // Government look-alike — phrases first.
  R(/\b(?:the\s+)?(?:government|govt\.?)(?:['’]s)?\s+of\s+india\b/gi, 'public'),
  R(/\b(?:the\s+)?(?:government|govt\.?)(?:['’]s)?\s+(?:vehicle\s+)?records?\s+(?:server|service|system)\b/gi, 'our vehicle records source'),
  R(/\b(?:a\s+)?(?:government|govt\.?)[-\s]+issued\b/gi, (m) => (/^a\s/i.test(m) ? 'an officially issued' : 'officially issued')),
  R(/\b(the\s+)?(?:government|govt\.?)(?:['’]s)?\s+(?:vehicle\s+)?(?:record(s?)|data(?:base)?)\b/gi,
    (_m, the, s) => `${the || ''}vehicle record${s === undefined ? 's' : s}`),
  R(/\b(?:the\s+)?(?:government|govt\.?)(?:['’]s)?\s+(?:server|service|system|portal|website|site)\b/gi, 'our records source'),
  R(/\b(?:the\s+)?(?:government|govt\.?)(?:['’]s)?\s+(?:e-?challan)\b/gi, 'e-challan'),
  R(/(?:vahan|parivahan|sarathi)\s*रिकॉर्ड/gi, 'वाहन रिकॉर्ड'),
  R(/\b(?:vahan|parivahan|sarathi)(?:\s+(?:and|&)\s+e-?challan)?\s+(?:records?|data(?:base)?)\b/gi, 'vehicle records'),
  R(/\b(?:vahan|parivahan|sarathi)(?:\.nic\.in|\.gov\.in)?\b/gi, 'vehicle records'),
  R(/\bofficial\s+(?:portal|website|site)\b/gi, 'website'),
  R(/\b(?:government|govt\.?)(?:['’]s)?\b/gi, 'public'),
  R(/सरकारी\s*रिकॉर्ड/g, 'वाहन रिकॉर्ड'),
  R(/सरकारी\s*/g, ''),
  R(/सरकार(?:ी|\s)?/g, ''),

  as('pressure'),
  // Pay-or-else pressure.
  R(/\b(?:to\s+)?avoid\s+(?:fines?|penalt\w+|challans?)\b/gi, (m) => (/^to\s/i.test(m) ? 'to stay on time' : 'stay on time')),
  R(/\bpay\s+(?:your|the)\s+(?:pending\s+)?(?:challans?|fines?)\b/gi, 'see your challan details'),
  R(/\blegal action\b/gi, 'follow-up'),
  R(/\blast chance\b/gi, 'reminder'),
  R(/\bact now\b/gi, 'when convenient'),
  R(/\bfailing which\b/gi, 'otherwise'),
].filter(Boolean).map((r) => ({
  ...r,
  // \b with "_" counted as a gap, not a letter: "_Government records_" (WhatsApp italics) matches whole.
  re: new RegExp(r.re.source.replace(/\\b/g, '(?:(?<![A-Za-z0-9])(?=[A-Za-z0-9])|(?<=[A-Za-z0-9])(?![A-Za-z0-9]))'), r.re.flags),
}));

const URL = /(https?:\/\/\S+)/i;

/** The text with every rule applied, outside links. */
function clean(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.split(URL).map((part, i) => {
    if (i % 2 === 1) return part;              // a URL: untouched
    let out = part;
    for (const r of RULES) {
      out = out.replace(r.re, (...a) => {
        const m = a[0]; const at = a[a.length - 2]; const whole = a[a.length - 1];
        let to = typeof r.to === 'function' ? r.to(...a) : r.to;
        // A capital only where a sentence starts ("Government records said…" → "Vehicle records said…").
        const before = whole.slice(0, at);
        if (/^[A-Z]/.test(m) && to && (!before.trim() || /[.!?:\n]\s*[*_]*$/.test(before) || /^[*_\s]+$/.test(before))) {
          to = to[0].toUpperCase() + to.slice(1);
        }
        return to;
      });
      r.re.lastIndex = 0;
    }
    return out;
  }).join('');
}

/** Does the text still hold any of the words (after cleaning, it never should)? */
function risky(text) {
  const s = String(text || '').split(URL).filter((_, i) => i % 2 === 0).join(' ');
  return RULES.some((r) => { const hit = r.re.test(s); r.re.lastIndex = 0; return hit; });
}

module.exports = { clean, risky, RULES };
