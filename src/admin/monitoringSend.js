/**
 * src/admin/monitoringSend.js — SEND THE MONITORING UPDATE NOW, TO CHOSEN PAID CUSTOMERS
 * (user, 2026-10-15: "an option in the admin panel where, for selected paid users, I can
 * trigger the daily monitoring template").
 *
 *   list()                       everyone with active monitoring: vehicles, when the last update
 *                                went, whether one went today, and how WhatsApp would carry it
 *                                (free message inside the 24-hour window, else the template)
 *   start({ userIds, adminId })  sends in the background, one at a time
 *   get(id) / stop(id)           how far it got / send no more
 *
 * The update itself is the evening job's (jobs/watch.dailyStatus, by hand for that number):
 * every vehicle they monitor, WhatsApp first, email and phone notification as well. So the same
 * guards hold — ONCE A DAY per customer (whoever sent it: this page or the evening job), never
 * to anyone who did not agree, said STOP, or while templates are paused (send.mayStart), never
 * retried. And only 9 am – 9 pm IST: an update is not news worth waking anyone for.
 *
 * A job lives in memory: a restart ends it (what was sent stays sent).
 */

const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');

const MAX = 50;
const GAP_MS = 3000;
const jobs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
const istDate = () => istNow().toISOString().slice(0, 10);

async function list() {
  const send = require('../whatsapp/send');
  const { rows } = await db.query(
    `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.is_internal,
            array_agg(DISTINCT v.reg_no ORDER BY v.reg_no) AS vehicles,
            max(w.expires_at) AS until,
            (u.email_verified_at IS NOT NULL AND u.email_unsubscribed_at IS NULL) AS email_ok,
            (SELECT max(e.created_at) FROM event_log e WHERE e.user_id = u.id
                AND e.kind IN ('watch_status', 'watch_digest') AND coalesce(e.detail->>'failed', 'false') <> 'true') AS last_sent,
            EXISTS (SELECT 1 FROM event_log e WHERE e.user_id = u.id AND e.kind = 'watch_status'
                       AND e.detail->>'ist_date' = $1) AS done_today
       FROM watches w
       JOIN users u    ON u.id = w.user_id
       JOIN vehicles v ON v.id = w.vehicle_id
      WHERE w.is_active AND (w.expires_at IS NULL OR w.expires_at > now())
        AND u.deactivated_at IS NULL AND NOT coalesce(u.is_paused, false)
        AND NOT EXISTS (SELECT 1 FROM user_vehicles uv WHERE uv.user_id = w.user_id AND uv.vehicle_id = w.vehicle_id AND uv.hidden_at IS NOT NULL)
      GROUP BY u.id
      ORDER BY 8 NULLS FIRST, u.id`, [istDate()]);
  const out = [];
  for (const r of rows) {
    const may = await send.mayStart(r.mobile);
    const open = may.ok && await send.windowOpen(r.mobile).catch(() => false);
    out.push({
      id: String(r.id), mobile: r.mobile, name: r.name, internal: r.is_internal, vehicles: r.vehicles, until: r.until,
      email_ok: r.email_ok, last_sent: r.last_sent, done_today: r.done_today,
      whatsapp: !may.ok ? { how: 'none', why: { not_agreed: 'has not agreed to the Terms', opted_out: 'said STOP', templates_paused: 'templates paused (spam brake)' }[may.why] || may.why }
        : { how: open ? 'free' : 'template' },
    });
  }
  const h = istNow().getUTCHours();
  return { rows: out, in_hours: h >= 9 && h < 21, max: MAX };
}

async function start({ userIds, adminId }) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(String).filter((x) => /^\d+$/.test(x)))];
  if (!ids.length) throw Object.assign(new Error('Tick at least one customer.'), { status: 400 });
  if (ids.length > MAX) throw Object.assign(new Error(`At most ${MAX} at a time.`), { status: 400 });
  const h = istNow().getUTCHours();
  if (h < 9 || h >= 21) throw Object.assign(new Error('Updates go only between 9 am and 9 pm (IST).'), { status: 400 });
  if (!(await settings.bool('whatsapp_sending_enabled', false))) {
    throw Object.assign(new Error('WhatsApp sending is switched off (Settings whatsapp_sending_enabled).'), { status: 400 });
  }

  const { rows } = await db.query(
    `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name FROM users u WHERE u.id = ANY($1::bigint[])`, [ids]);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const job = {
    id: crypto.randomBytes(6).toString('hex'), admin_id: adminId, started_at: new Date(),
    total: ids.length, sent: 0, skipped: 0, failed: 0, stopped: false, done: false,
    people: ids.map((id) => ({ id, tail: String(byId.get(id)?.mobile || '').slice(-4), name: byId.get(id)?.name || null, status: 'waiting', note: null })),
  };
  jobs.set(job.id, job);
  for (const [k, j] of jobs) if (j.done && Date.now() - j.started_at > 6 * 3600e3) jobs.delete(k);

  (async () => {
    const watch = require('../jobs/watch');
    for (let i = 0; i < ids.length; i += 1) {
      const p = job.people[i];
      const u = byId.get(ids[i]);
      if (job.stopped) { p.status = 'not sent'; p.note = 'stopped'; job.skipped += 1; continue; }
      if (!u) { p.status = 'skipped'; p.note = 'no such customer'; job.skipped += 1; continue; }
      let result = null;
      try {
        await watch.dailyStatus({ mobile: u.mobile, onEach: ({ out }) => { result = out; } });
      } catch (e) { result = { ok: false, error: e.message }; }
      if (!result) { p.status = 'skipped'; p.note = 'already sent today, or nothing to send'; job.skipped += 1; }
      else if (result.ok) { p.status = 'sent'; p.note = result.channel || null; job.sent += 1; }
      else { p.status = 'not delivered'; p.note = String(result.error || '').slice(0, 160); job.failed += 1; }
      if (i < ids.length - 1 && !job.stopped) await sleep(GAP_MS);
    }
    job.done = true;
    console.log('[monitoring-send] %d sent, %d skipped, %d not delivered (by hand)', job.sent, job.skipped, job.failed);
  })().catch((e) => { job.done = true; console.error('[monitoring-send] stopped:', e.message); });

  return get(job.id);
}

function get(id) {
  const j = jobs.get(String(id));
  return j ? { ...j } : null;
}

function stop(id) {
  const j = jobs.get(String(id));
  if (!j) return null;
  j.stopped = true;
  return get(id);
}

module.exports = { list, start, get, stop };
