/**
 * src/admin/replyMany.js — ONE MESSAGE TO MANY OPEN CHATS (user, 2026-10-14: "in Hot leads,
 * select multiple contacts who are within 24 hrs, or all, then one message to all of them").
 *
 *   start({ mobiles, text, buttons, adminId })  checks, then sends in the background
 *   get(id)                                     how far it got
 *   stop(id)                                    sends no more
 *
 * Each person goes through the same door as a single reply (opsExtras.reply): only inside
 * their 24-hour window, with up to three of the bot's own buttons. Before that, anyone who
 * never agreed on WhatsApp or said STOP is left out (consented.allowedOf).
 *
 * NOT A BULK BLAST: one at a time, wa_bulk_reply_gap_seconds apart (5 by default), at most
 * MAX a time, and {name} in the text becomes each person's first name — the same words
 * pasted to dozens of people in seconds is what gets an account reported.
 *
 * A job lives in memory: a restart ends it (what was sent stays sent, and every message is
 * in whatsapp_messages as usual).
 */

const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');

const MAX = 100;
const jobs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ten = (v) => String(v || '').replace(/\D/g, '').slice(-10);

/* "Ravi Kumar" -> "Ravi"; nothing usable -> "there" ("Hi there"). */
function firstName(name) {
  const w = String(name || '').trim().split(/\s+/)[0] || '';
  return /^[\p{L}][\p{L}.'-]{1,20}$/u.test(w) ? w : 'there';
}

async function start({ mobiles, text, buttons = [], adminId }) {
  const body = String(text || '').trim();
  if (!body) throw Object.assign(new Error('Write a message first.'), { status: 400 });
  const list = [...new Set((Array.isArray(mobiles) ? mobiles : []).map(ten).filter((m) => m.length === 10))];
  if (!list.length) throw Object.assign(new Error('Tick at least one person.'), { status: 400 });
  if (list.length > MAX) throw Object.assign(new Error(`At most ${MAX} people at a time.`), { status: 400 });

  const allowed = await require('./consented').allowedOf(list, { whatsappOnly: true });
  const { rows } = await db.query(
    `SELECT right(u.mobile, 10) AS m, coalesce(u.display_name, u.wa_profile_name, s.profile_name) AS name
       FROM unnest($1::text[]) AS x(m)
       LEFT JOIN users u ON right(u.mobile, 10) = x.m
       LEFT JOIN whatsapp_sessions s ON right(s.mobile, 10) = x.m`, [list]);
  const names = Object.fromEntries(rows.map((r) => [r.m, r.name]));
  const gap = Math.max(2, Math.min(60, await settings.num('wa_bulk_reply_gap_seconds', 5)));

  const job = {
    id: crypto.randomBytes(6).toString('hex'), admin_id: adminId, started_at: new Date(), gap_seconds: gap,
    total: list.length, sent: 0, skipped: 0, failed: 0, stopped: false, done: false,
    // Last four digits only: the answer goes through the panel's own filters.
    people: list.map((m) => ({ tail: m.slice(-4), name: names[m] || null, status: 'waiting', note: null })),
  };
  jobs.set(job.id, job);
  for (const [k, j] of jobs) if (j.done && Date.now() - j.started_at > 6 * 3600e3) jobs.delete(k);

  (async () => {
    const reply = require('./opsExtras').reply;
    for (let i = 0; i < list.length; i += 1) {
      const p = job.people[i];
      if (job.stopped) { p.status = 'not sent'; p.note = 'stopped'; job.skipped += 1; continue; }
      if (!allowed.has(list[i])) { p.status = 'skipped'; p.note = 'has not agreed on WhatsApp, or said STOP'; job.skipped += 1; continue; }
      try {
        await reply(list[i], body.replace(/\{name\}/gi, firstName(names[list[i]])), adminId, buttons);
        p.status = 'sent'; job.sent += 1;
      } catch (e) {
        const closed = e.status === 409;
        p.status = closed ? 'skipped' : 'failed'; p.note = closed ? '24-hour window closed' : e.message;
        if (closed) job.skipped += 1; else job.failed += 1;
        // WhatsApp switched off, or the account locked: nobody else will get it either.
        if (/whatsapp_off|131031|131048/.test(e.message)) job.stopped = true;
      }
      if (i < list.length - 1 && !job.stopped) await sleep(gap * 1000);
    }
    job.done = true;
    const act = require('../util/activity');
    act.log('📣', `One message to many (Hot leads) · ${job.sent} sent, ${job.skipped} skipped, ${job.failed} failed`,
      { detail: `“${body.slice(0, 80)}”` });
  })().catch((e) => { job.done = true; job.error = e.message; console.error('[reply-many]', e.message); });

  return view(job);
}

function view(job) {
  const { admin_id: _a, ...out } = job;
  return out;
}
const get = (id) => (jobs.has(id) ? view(jobs.get(id)) : null);
function stop(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.stopped = true;
  return view(job);
}

module.exports = { start, get, stop, firstName, MAX };
