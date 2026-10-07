/**
 * src/util/consoleTap.js — THE SERVER'S OWN LOG, FOR THE WEB ADMIN (user,
 * 2026-10-07: "every event or trigger logged in the console, and in a separate
 * log in the web admin").
 *
 * Installed first thing in app.js: every console.log / warn / error still goes
 * to the terminal (and pm2's log files) exactly as before, and the last 3,000
 * lines are also kept in memory with their time and level, numbered, for the
 * web admin's Server log (GET /admin/api/web/server-log). Nothing is written to
 * disk here; a restart starts the list afresh (pm2 keeps the files).
 */

const util = require('util');

const MAX = 3000;
const lines = [];
let seq = 0;
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      try {
        const text = util.format(...args);
        const tag = (/^\s*\[([^\]]{1,40})\]/.exec(text) || [])[1] || null;
        seq += 1;
        lines.push({ n: seq, at: new Date().toISOString(), level: level === 'info' ? 'log' : level, tag, text: text.slice(0, 2000) });
        if (lines.length > MAX) lines.splice(0, lines.length - MAX);
      } catch { /* the log must never break the server */ }
    };
  }
}

/** Lines after `since` (a line number), newest last; filtered by level, tag or text. */
function read({ since = 0, level = '', q = '', limit = 500 } = {}) {
  const term = String(q || '').toLowerCase();
  const out = lines.filter((l) => l.n > Number(since || 0)
    && (!level || l.level === level)
    && (!term || l.text.toLowerCase().includes(term)));
  const tags = {};
  for (const l of lines) if (l.tag) tags[l.tag] = (tags[l.tag] || 0) + 1;
  return { last: seq, kept: lines.length, rows: out.slice(-Math.min(2000, Number(limit) || 500)), tags };
}

module.exports = { install, read };
