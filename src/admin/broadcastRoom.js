/**
 * src/admin/broadcastRoom.js — THE BROADCAST ROOM (user, 2026-10-06: "now you
 * can send x customers, after 24 hrs this much ... suggest the customers batch
 * which fits Meta's rolling 24 hours, announcement template only. The main
 * target is to unlock the next tier").
 *
 * META'S RULE (developers.facebook.com … /whatsapp/messaging-limits, read
 * 2026-10-06): the limit is the number of DIFFERENT WhatsApp numbers the
 * business portfolio delivers to outside a customer service window, in a
 * MOVING 24 hours — shared by every number in the portfolio, so QuizPe's sends
 * use GaadiPe's room. A number counts while its latest send is inside the
 * window; its slot frees 24 hours after that send.
 *
 *   room()        free now, what is queued or booked by batch plans, and when
 *                 the next slots free up, hour by hour
 *   suggest()     today's batch: the customers best to send to, as many as
 *                 fit the room (minus a buffer)
 *   send()        queue that batch — the announcement template only, and never
 *                 more than the room
 *   tier()        how far along the way to Meta's next limit:
 *                   250 -> 2,000   business verification, OR 2,000 different
 *                                  numbers delivered to in a moving 30 days
 *                   2,000 and up   half the limit used in the last 7 days with
 *                                  good quality — Meta raises it within 6 hours
 *
 * Everything here READS, except send(), which hands the batch to the ordinary
 * broadcast queue (admin/broadcasts.js) — the same door, guards and pace as
 * any broadcast. QuizPe is read through the read-only peer link only.
 *
 * The counts are a little on the safe side: every template counts, even one
 * to someone whose chat window was open (Meta would not count that one).
 */

const db = require('../db');
const settings = require('../util/settings');
const broadcasts = require('./broadcasts');

const ten = (m) => String(m || '').replace(/\D/g, '').slice(-10);
const ANNOUNCEMENT = /^gp_announcement/i;

/** Every number messaged first in the last `hours`, GaadiPe and QuizPe together: Map(m -> { at, apps }). */
async function sentWithin(hours) {
  const { rows } = await db.query(
    `SELECT right(regexp_replace(mobile, '\\D', '', 'g'), 10) AS m, max(created_at) AS at
       FROM whatsapp_messages
      WHERE direction = 'out' AND message_type = 'template' AND created_at > now() - make_interval(hours => $1::int)
        AND coalesce(error_message, '') = ''
      GROUP BY 1`, [hours]);
  const quizpe = await require('../util/peer').quizpeRecipients(hours).catch(() => null);
  const map = new Map();
  const add = (r, app) => {
    if (String(r.m || '').length !== 10) return;
    const at = new Date(r.at).getTime();
    const cur = map.get(r.m);
    if (!cur) map.set(r.m, { at, apps: new Set([app]) });
    else { cur.at = Math.max(cur.at, at); cur.apps.add(app); }
  };
  rows.forEach((r) => add(r, 'gaadipe'));
  (quizpe || []).forEach((r) => add(r, 'quizpe'));
  return { map, linked: quizpe !== null };
}

/** Numbers waiting in a broadcast that has not gone out yet. */
async function queuedNumbers() {
  const { rows } = await db.query(
    `SELECT DISTINCT right(regexp_replace(mobile, '\\D', '', 'g'), 10) AS m
       FROM whatsapp_broadcast_targets WHERE status = 'pending'`);
  return new Set(rows.map((r) => r.m));
}

/** People the running batch plans will send to within the next 24 hours. */
async function booked() {
  const { rows } = await db.query(
    `SELECT * FROM broadcast_plans WHERE status = 'running' AND next_at <= now() + interval '24 hours' ORDER BY next_at`);
  const { progress } = require('./broadcastPlans')._test;
  let n = 0;
  const plans = [];
  for (const p of rows) {
    const left = (await progress(p)).left.length;
    const size = Math.min(Number(p.batch_size) || 0, left);
    if (size > 0) { n += size; plans.push({ id: String(p.id), at: p.next_at, size }); }
  }
  return { n, plans };
}

async function adminNumbers() {
  const listed = String(await settings.get('admin_whatsapp_numbers', '')).split(/[,\s;]+/).map(ten).filter((m) => m.length === 10);
  const { rows } = await db.query(`SELECT mobile FROM admin_users WHERE mobile IS NOT NULL`).catch(() => ({ rows: [] }));
  return new Set([...listed, ...rows.map((r) => ten(r.mobile)).filter((m) => m.length === 10)]);
}

/** Free now, and when more frees up. */
async function room() {
  const limit = await settings.num('whatsapp_messaging_limit', 250);
  const buffer = Math.max(0, await settings.num('broadcast_room_buffer', 15));
  const { map, linked } = await sentWithin(24);
  const queued = [...await queuedNumbers()].filter((m) => !map.has(m)).length;
  const plans = await booked();
  const used = map.size;
  let gaadipe = 0; let quizpe = 0;
  for (const v of map.values()) { if (v.apps.has('gaadipe')) gaadipe++; if (v.apps.has('quizpe')) quizpe++; }
  const freeNow = Math.max(0, limit - used - queued);
  const suggestNow = Math.max(0, freeNow - buffer - plans.n);

  // Each slot frees 24 hours after that number's latest send — grouped by the hour it frees in.
  const buckets = new Map();
  for (const v of map.values()) {
    const at = v.at + 24 * 3600e3;
    const hour = Math.ceil(at / 3600e3) * 3600e3;
    buckets.set(hour, (buckets.get(hour) || 0) + 1);
  }
  let free = freeNow;
  const opens = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([at, n]) => {
    free = Math.min(limit, free + n);
    return { at: new Date(at).toISOString(), n, free_after: free };
  });

  return {
    limit, used, gaadipe, quizpe, quizpe_linked: linked, queued, buffer,
    booked: plans.n, booked_plans: plans.plans,
    free_now: freeNow, suggest_now: suggestNow, opens,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Today's batch: as many as fit, best first. Left out: STOP (not in PEOPLE at
 * all), blocked, admin and internal numbers, anyone messaged in the last 24 h
 * or already queued, anyone whose chat is open (no slot needed — talk to them
 * there), anyone broadcast to in the last gap days, and numbers where two
 * broadcasts failed in 30 days (likely not on WhatsApp — failures hurt quality).
 *
 * Order: never had a broadcast first, then the most recently active, then the
 * longest since their last broadcast.
 */
async function suggest({ size = null, filter = null } = {}) {
  const r = await room();
  // Within an audience chosen on Broadcast ("Auto-select", user 2026-10-06); everyone when none.
  const audience = filter ? broadcasts.filterWhere(filter) : 'true';
  const want = Math.max(0, Math.min(size == null ? r.suggest_now : Number(size) || 0, r.suggest_now));
  const gapDays = Math.max(0, await settings.num('broadcast_room_gap_days', 7));
  const skip = new Set([...(await sentWithin(24)).map.keys(), ...await queuedNumbers(), ...await adminNumbers()]);
  const { rows } = await db.query(
    `${broadcasts.PEOPLE}
     SELECT p.*, right(regexp_replace(p.mobile, '\\D', '', 'g'), 10) AS m
       FROM (SELECT * FROM people WHERE ${audience}) p
       LEFT JOIN users u ON u.id = p.user_id
      WHERE NOT p.blocked
        AND NOT coalesce(u.is_internal, false)
        AND right(regexp_replace(p.mobile, '\\D', '', 'g'), 10) <> ALL($1::text[])
        AND (p.last_message IS NULL OR p.last_message < now() - interval '24 hours')
        AND (p.last_broadcast_at IS NULL OR p.last_broadcast_at < now() - make_interval(days => $2::int))
        AND (SELECT count(*) FROM whatsapp_broadcast_targets t
              WHERE t.mobile = p.mobile AND t.status = 'failed' AND t.created_at > now() - interval '30 days') < 2
      ORDER BY p.got_broadcast ASC, greatest(p.last_checked, p.last_message) DESC NULLS LAST,
               p.last_broadcast_at ASC NULLS FIRST, p.created_at DESC`,
    [[...skip], gapDays]);
  const pick = rows.slice(0, want).map((p) => ({
    mobile: p.mobile, name: p.display_name || p.wa_profile_name || null, last_vehicle: p.last_vehicle,
    last_active: [p.last_checked, p.last_message].filter(Boolean).sort((a, b) => new Date(a) - new Date(b)).pop() || null,
    last_broadcast_at: p.last_broadcast_at,
    why: !p.got_broadcast ? 'Never had a broadcast' : `Last broadcast ${Math.round((Date.now() - new Date(p.last_broadcast_at)) / 864e5)} days ago`,
  }));
  return { room: r, eligible: rows.length, size: pick.length, gap_days: gapDays, rows: pick, templates: await announcementTemplates() };
}

/** The announcement templates Meta approved — the only ones this batch may use. */
async function announcementTemplates() {
  const list = await broadcasts.templates().catch(() => ({ ok: false }));
  return (list.ok ? list.templates : []).filter((t) => ANNOUNCEMENT.test(t.name))
    .map((t) => ({ name: t.name, language: t.language, status: t.status, sendable: t.sendable, body: t.body, footer: t.footer,
                   header_text: t.header_text, buttons: t.buttons, variables: t.variables }));
}

/** Queue the batch: announcement template only, never more than the room. */
async function send({ template_name, language = 'en', variables = [], mobiles = [], note = '' }, adminId) {
  if (!ANNOUNCEMENT.test(String(template_name || ''))) {
    return { ok: false, message: 'Today’s batch can only use the announcement template.' };
  }
  const people = [...new Set((mobiles || []).map(ten).filter((m) => m.length === 10))];
  if (!people.length) return { ok: false, message: 'No customers in the batch.' };
  const r = await room();
  if (people.length > r.suggest_now) {
    return { ok: false, message: `Only ${r.suggest_now} fit right now (${r.free_now} free, ${r.buffer} kept free${r.booked ? `, ${r.booked} booked by batch plans` : ''}). Refresh the suggestion.` };
  }
  const out = await broadcasts.queue({ template_name, language, variables, mobiles: people,
    note: `Broadcast room · today’s batch${note ? ` · ${note}` : ''}` }, adminId);
  if (out.ok) {
    await require('./auth').audit({ adminId, action: 'broadcast_room_sent',
      detail: { broadcast_id: out.id, template_name, people: people.length, room: r.suggest_now } }).catch(() => {});
  }
  return out;
}

/** The way to the next Meta limit. */
async function tier() {
  const meta = await require('../jobs/metaStatus').current().catch(() => null);
  const limit = await settings.num('whatsapp_messaging_limit', 250);
  const [d7, d30] = await Promise.all([sentWithin(24 * 7), sentWithin(24 * 30)]);
  const reachable = await db.one(
    `${broadcasts.PEOPLE} SELECT count(*) FILTER (WHERE NOT blocked)::int AS n FROM people`).catch(() => ({ n: null }));
  const verified = /^verified$/i.test(String(meta?.business_verification || ''));
  const out = {
    limit, tier: meta?.tier || null, quality: meta?.quality || null,
    business_verification: meta?.business_verification || null, verified,
    checked_at: meta?.checked_at || null, reachable: reachable.n,
    unique_7d: d7.map.size, unique_30d: d30.map.size,
  };
  if (limit < 2000) {
    // 250 -> 2,000: verify the business, or 2,000 different numbers in 30 days.
    out.next = 2000;
    out.paths = [
      { key: 'verify', label: 'Verify the business', done: verified, status: meta?.business_verification || 'unknown',
        note: verified ? 'Verified — Meta should raise the limit after reviewing message quality.'
          : 'Meta Business Suite → Security Centre → Start verification. The quickest way to 2,000.' },
      { key: 'volume', label: '2,000 different customers in 30 days', have: d30.map.size, need: 2000,
        note: reachable.n != null && reachable.n < 2000
          ? `You have ${reachable.n} customers you can message in all, so this way needs more customers first — verification is the way for now.`
          : 'Templates delivered outside open chats, with high quality.' },
    ];
  } else {
    // 2,000 and up: half the limit in 7 days, with good quality.
    const need = Math.ceil(limit / 2);
    out.next = { 2000: 10000, 10000: 100000 }[limit] ?? null;   // 100,000 -> unlimited
    out.paths = [{ key: 'half', label: `Reach ${need} different customers in 7 days`, have: d7.map.size, need,
      per_day: Math.max(0, Math.ceil((need - d7.map.size) / 7)),
      note: 'Meta checks this by itself and raises the limit within 6 hours.' }];
  }
  out.quality_note = meta?.quality === 'GREEN' || !meta?.quality ? null
    : 'Quality is not high — pause broadcasts until it recovers. Blocks and reports lower it; a lower quality can lower the limit.';
  return out;
}

module.exports = { room, suggest, send, tier, ANNOUNCEMENT };
