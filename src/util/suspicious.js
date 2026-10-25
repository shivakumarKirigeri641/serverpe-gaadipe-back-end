/**
 * src/util/suspicious.js — NOTICING SOMEONE PROBING (user, 2026-10-25: "I need some extra guard to prevent
 * suspicious" — one visitor typed four mobile numbers into the vehicle box, then tapped every menu in a loop).
 *
 * Counts, in memory, repeated tries of one kind from one source (an IP address or a WhatsApp number) and tells the
 * admin once a source passes the limit inside the window: an alert, never a block — blocking stays the admin's call
 * (Customers → Block). Memory is enough: a restart forgets the counts, and the alert is about what is happening now.
 *
 *   note('mobile_lookup', '27.59.94.165', { said: '98•••••415' })
 *   note('otp_ip_limit', '27.59.94.165', { numbers: 4 }, { limit: 1 })
 */
const hits = new Map();          // `${kind}|${source}` -> [timestamps]
const alerted = new Map();       // `${kind}|${source}` -> time of the last alert

const WORDS = {
  mobile_lookup: 'typed mobile numbers where a vehicle number goes (looking people up by phone?)',
  otp_ip_limit: 'asked for sign-in codes for several different mobile numbers from one device',
  api_misuse: 'called GaadiPe\'s systems directly instead of through the website (a copied key, a replayed request, a script, or a hand-made call)',
};

function note(kind, source, detail = {}, { limit = 3, windowMinutes = 10 } = {}) {
  if (!source) return;
  const key = `${kind}|${source}`;
  const now = Date.now();
  const since = now - windowMinutes * 60e3;
  const list = (hits.get(key) || []).filter((t) => t > since);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);   // never grow without bound
  if (list.length < limit) return false;
  // One alert per source and kind per window, however long they keep at it. True once the limit is passed,
  // so a caller can act (block) as well as tell.
  if (now - (alerted.get(key) || 0) < windowMinutes * 60e3) return true;
  alerted.set(key, now);
  const lines = Object.entries(detail).filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  console.warn('[suspicious] %s from %s (%d in %d min)', kind, source, list.length, windowMinutes);
  require('./adminPing').ping({
    key: `suspicious:${kind}:${source}:${Math.floor(now / (windowMinutes * 60e3))}`,
    severity: 'warning', source: 'security',
    title: '🕵️ Suspicious activity',
    text: [`Someone ${WORDS[kind] || kind} — ${list.length} time${list.length === 1 ? '' : 's'} in ${windowMinutes} minutes.`,
      `From: ${source}`, ...lines,
      'Nothing was revealed. If it continues, block the number or the visitor from the admin.'].join('\n'),
  }).catch(() => {});
  return true;
}

/** "98•••••415" — enough to recognise a pattern, not the number itself. */
const mask = (s) => {
  const d = String(s || '').replace(/\D/g, '');
  return d.length >= 6 ? `${d.slice(0, 2)}•••••${d.slice(-3)}` : '•••';
};

module.exports = { note, mask };
