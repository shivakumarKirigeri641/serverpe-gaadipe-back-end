/**
 * src/whatsapp/junk.js — A PAUSE FOR MEANINGLESS MESSAGES (user, 2026-10-25: "one of the customers is simply
 * chatting with invalid characters" — asked for a fake "server is down"; an honest pause instead).
 *
 * A typed message with nothing in it to act on — one or two characters, or only symbols — is junk. A number
 * that sends wa_junk_mute_after of them (6) within 10 minutes is told once, honestly, that the bot will pause,
 * and then gets no replies to junk for wa_junk_mute_minutes (60) - anything real (a vehicle number, a word, a
 * button tap) ends the pause and is answered. Their messages are still recorded (routes/whatsapp.js).
 * Never junk: button and list taps, media, STOP / START, hi / menu, anything with a vehicle number in it.
 * Held in memory: a restart simply forgets, which only ever errs towards answering.
 */
const settings = require('../util/settings');

const WINDOW_MS = 10 * 60 * 1000;
const seen = new Map();      // mobile -> [times of junk messages]
const muted = new Map();     // mobile -> until (ms)

const KEEP = /^(stop|start|unstop|subscribe|unsubscribe|hi+|hello|hey|menu|help)$/i;

function isJunk(message) {
  if (message?.type !== 'text') return false;
  const t = String(message?.text?.body || '').trim();
  if (!t || KEEP.test(t)) return false;
  if (/[A-Za-z]{2}\s*\d{1,2}/.test(t)) return false;                  // the start of a vehicle number
  const meaningful = t.replace(/[^A-Za-z0-9ऀ-෿]/g, '');     // letters, digits, Indian scripts
  return meaningful.length <= 2;
}

/**
 * 'answer' — handle as usual; 'notice' — tell them about the pause (once), then stay quiet;
 * 'quiet' — paused: record only.
 */
async function check(mobile, message) {
  const now = Date.now();
  const text = String(message?.text?.body || '').trim();
  const until = muted.get(mobile) || 0;
  // During the pause only junk goes unanswered: a vehicle number, a word, a tap or STOP ends it.
  if (!isJunk(message)) { muted.delete(mobile); return 'answer'; }
  if (until > now) return /^(stop|start|unstop)$/i.test(text) ? 'answer' : 'quiet';
  if (until) muted.delete(mobile);
  const times = (seen.get(mobile) || []).filter((t) => now - t < WINDOW_MS);
  times.push(now);
  seen.set(mobile, times);
  if (seen.size > 5000) seen.clear();
  if (times.length < await settings.num('wa_junk_mute_after', 6)) return 'answer';
  muted.set(mobile, now + (await settings.num('wa_junk_mute_minutes', 60)) * 60 * 1000);
  seen.delete(mobile);
  return 'notice';
}

const NOTICE = 'We are unable to process these messages, so automatic replies on this chat are paused for about an hour.\n\n'
  + 'To continue at any time, simply send a vehicle registration number (for example, *KA01AB1234*) and we will '
  + 'resume right away.\n\n_Thank you — Team GaadiPe_';

module.exports = { check, isJunk, NOTICE };
