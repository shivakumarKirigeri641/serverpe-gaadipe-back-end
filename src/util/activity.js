/**
 * src/util/activity.js — WHAT HAPPENED, IN PLAIN WORDS (user, 2026-10-08:
 * "give proper logs in the server for every activity — understandable —
 * including users' entries and my mail broadcasting").
 *
 *   activity.log(icon, text, { who, mobile, detail })
 *
 * One line per thing that happened, for a person to read:
 *
 *   [activity] 11:42:05 🔐 Signed in · Shivakumar (…2415) · Android · Chrome · Bengaluru
 *   [activity] 11:42:31 🔍 Vehicle checked · KA01AB1234 · found (VAHAN/04) · Shivakumar (…2415)
 *   [activity] 11:44:10 📧 Broadcast queued by Shivakumar (admin) · "Insurance reminder" · 128 recipients
 *
 * Each line goes three places: the console (so pm2 logs and the web admin's
 * Server log show it — filter by "activity"), and a daily file,
 * logs/activity-YYYY-MM-DD.log (Indian time), kept 60 days. A mobile number is
 * never written whole: only its last four digits. Nothing here may ever throw.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.ACTIVITY_LOG_DIR || path.join(__dirname, '..', '..', 'logs');
const KEEP_DAYS = Number(process.env.ACTIVITY_LOG_KEEP_DAYS) || 60;

const ist = (d = new Date()) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(d).reduce((a, x) => ({ ...a, [x.type]: x.value }), {});
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
};

/** "Shivakumar (…2415)" — a name if known, and the last four digits only. */
/* The owner's own activity is left out of the log (user, 2026-10-25: "remove my logs when I do some activities"):
   who() marks it, log() drops the line. */
const OWN = '\u0000own';
function who(name, mobile) {
  if (require('./own').isOwn({ mobile })) return OWN;
  const m = String(mobile || '').replace(/\D/g, '');
  const tail = m.length >= 4 ? `…${m.slice(-4)}` : null;
  const n = String(name || '').trim();
  return n && tail ? `${n} (${tail})` : n || tail || 'a visitor';
}

/* "Ravi (…2415)" from a mobile alone (user, 2026-10-14: WhatsApp lines in the log): the
   customer's name from users, remembered for ten minutes so a chat is not a query a line. */
const names = new Map();
async function whoOf(mobile, name = null) {
  const m = String(mobile || '').replace(/\D/g, '').slice(-10);
  if (name || m.length !== 10) return who(name, mobile);
  const hit = names.get(m);
  if (hit && hit.at > Date.now() - 10 * 60 * 1000) return who(hit.name, m);
  let found = null;
  try {
    const r = await require('../db').one(
      `SELECT coalesce(display_name, wa_profile_name) AS name FROM users WHERE right(mobile, 10) = $1 LIMIT 1`, [m]);
    found = r?.name || null;
  } catch { /* the name is a nicety */ }
  if (names.size > 5000) names.clear();
  names.set(m, { name: found, at: Date.now() });
  return who(found, m);
}

/* Long numbers that look like a mobile are cut to their last four digits, even
   inside free text — a log is read by many and kept for weeks. */
const scrub = (s) => String(s ?? '').replace(/(?<![A-Z0-9])(?:\+?91[\s-]?)?([6-9]\d{9})(?![0-9])/g, (_, m) => `…${m.slice(-4)}`)
  .replace(/\s+/g, ' ').trim();

let dirReady = false;
let lastSweep = '';
function toFile(day, line) {
  try {
    if (!dirReady) { fs.mkdirSync(DIR, { recursive: true }); dirReady = true; }
    fs.appendFile(path.join(DIR, `activity-${day}.log`), `${line}\n`, () => {});
    if (lastSweep !== day) { lastSweep = day; sweep(); }
  } catch { /* the log must never break the server */ }
}
function sweep() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 864e5;
    for (const f of fs.readdirSync(DIR)) {
      const m = /^activity-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && Date.parse(`${m[1]}T00:00:00+05:30`) < cutoff) fs.unlink(path.join(DIR, f), () => {});
    }
  } catch { /* nothing to sweep */ }
}

/**
 * log('🔐', 'Signed in', { who: who(name, mobile), detail: ['Android · Chrome', 'Bengaluru'] })
 * `detail` may be a string or a list; empty parts are left out.
 */
function log(icon, text, { who: person = null, detail = null } = {}) {
  if (person === OWN) return;
  try {
    const { day, time } = ist();
    const parts = [scrub(text)];
    if (person) parts.push(scrub(person));
    for (const d of (Array.isArray(detail) ? detail : [detail])) if (d != null && String(d).trim()) parts.push(scrub(d));
    const body = `${icon} ${parts.join(' · ')}`.slice(0, 600);
    console.log(`[activity] ${body}`);      // the console / Server log has its own time; the file below keeps it
    toFile(day, `${day} ${time} ${body}`);
  } catch { /* never */ }
}

module.exports = { log, who, whoOf, DIR };
