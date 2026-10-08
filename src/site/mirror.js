/**
 * src/site/mirror.js — WHAT THE VISITOR SEES, for the web admin's visit screen
 * (user, 2026-10-08: "a conversational view, similar to mobile — a live replica").
 *
 * The chat page sends a compact copy of its conversation after each change:
 * the bubbles as shown, a vehicle card as its summary, and what the input box
 * is asking for. Nothing typed-but-not-sent is ever included; a sign-in code
 * is already shown as dots on the visitor's own screen and arrives that way;
 * emails and long numbers in the visitor's own bubbles are masked again here.
 *
 * Kept in this process's memory only — a live view, not a record: the newest
 * copy per visit, gone two hours after the last update (or on a restart).
 * Dropped while monitoring is off for the visit (site/presence.js).
 */

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_VISITS = 3000;
const MAX_ITEMS = 60;
const screens = new Map();

const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));
const mask = (s) => String(s || '')
  .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, (e) => `${e.slice(0, 2)}•••@${e.split('@')[1]}`)
  .replace(/\b\d{6,}\b/g, (d) => (d.length === 10 ? `${d.slice(0, 2)}••••••${d.slice(-2)}` : '•'.repeat(d.length)));

function cleanItem(it) {
  if (!it || typeof it !== 'object') return null;
  const from = it.from === 'me' ? 'me' : 'bot';
  const out = { from, kind: clip(it.kind, 20) || 'text', at: clip(it.at, 30) };
  // The visitor's own words are masked again here (emails, long numbers); a
  // plate is a plate. The bot's words are ours.
  if (it.text != null) out.text = from === 'me' && out.kind !== 'plate' ? mask(clip(it.text, 300)) : clip(it.text, 1200);
  if (Array.isArray(it.chips)) out.chips = it.chips.slice(0, 6).map((c) => clip(c, 40));
  if (it.card && typeof it.card === 'object') {
    out.card = {};
    for (const [k, v] of Object.entries(it.card).slice(0, 12)) {
      out.card[clip(k, 24)] = Array.isArray(v) ? v.slice(0, 8).map((x) => clip(x, 80)) : clip(v, 160);
    }
  }
  return out;
}

function put(sessionId, { visitorId, items, mode, page, input } = {}) {
  if (!sessionId) return;
  const list = (Array.isArray(items) ? items : []).slice(-MAX_ITEMS).map(cleanItem).filter(Boolean);
  screens.set(sessionId, { at: Date.now(), visitorId, items: list, mode: clip(mode, 20), page: clip(page, 120), input: clip(input, 80) });
  if (screens.size > MAX_VISITS) {
    const oldest = [...screens.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, screens.size - MAX_VISITS);
    oldest.forEach(([k]) => screens.delete(k));
  }
}

function get(sessionId) {
  const s = screens.get(sessionId);
  if (!s) return null;
  if (Date.now() - s.at > TTL_MS) { screens.delete(sessionId); return null; }
  return { ...s, age_s: Math.round((Date.now() - s.at) / 1000) };
}

function forget(sessionId) { screens.delete(sessionId); }

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of screens) if (now - s.at > TTL_MS) screens.delete(k);
}, 10 * 60 * 1000).unref();

module.exports = { put, get, forget };
