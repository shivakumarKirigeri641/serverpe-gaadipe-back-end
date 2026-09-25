/**
 * src/admin/vehicleOps.js — what admins do with vehicles, and what the
 * vehicles tell them (user, 2026-09-25, the Vehicles module).
 * ---------------------------------------------------------------------------
 *   notes      add, edit (the old text is kept), withdraw — never deleted
 *   tags       internal labels: important, follow_up, api_issue, …
 *   lists      saved vehicle lists shared by the team
 *   assign / archive   who is looking after it; out of the operational views
 *   prefs      one admin's explorer layout and saved filters
 *   intel      most-searched vehicles, RTOs, makers, models, repeats
 *   signals    patterns worth a look — never an accusation, never an action
 *   live       the stream of vehicle events as they happen
 *
 * Every write names its vehicle(s) in the audit detail (reg_no / vehicle_id),
 * which is how a vehicle's profile shows its own audit history.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const auth = require('./auth');
const settings = require('../util/settings');
const plate = require('../util/plate');
const command = require('./command');
const { maskMobile, find } = require('./vehicles');

const TAGS = ['important', 'follow_up', 'api_issue', 'payment_issue', 'customer_support', 'suspicious', 'vip'];
const tagOf = (t) => String(t || '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 24);
const ids = (xs) => [...new Set((Array.isArray(xs) ? xs : [xs]).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);

async function audit(admin, ip, action, detail) {
  await auth.audit({ adminId: admin.id, action, ip, detail });
}
/* Vehicles by id, with their numbers for the audit trail. */
async function vehiclesById(vehicleIds) {
  const { rows } = await db.query(`SELECT id, reg_no FROM vehicles WHERE id = ANY($1::bigint[])`, [vehicleIds]);
  return rows;
}

/* ─────────────────────────────── notes ─────────────────────────────── */

async function addNote({ reg, body, admin, ip }) {
  const v = await find(reg);
  const text = String(body || '').trim();
  if (!v) return { ok: false, message: 'No such vehicle.' };
  if (!text || text.length > 4000) return { ok: false, message: 'Write a note of up to 4,000 characters.' };
  const n = await db.one(`INSERT INTO vehicle_notes (vehicle_id, admin_id, body) VALUES ($1, $2, $3) RETURNING id`, [v.id, admin.id, text]);
  await audit(admin, ip, 'vehicle_note_added', { reg_no: v.reg_no, vehicle_id: String(v.id), note_id: String(n.id) });
  return { ok: true, id: String(n.id) };
}

/* Only the note's author (or someone who manages admins) edits or withdraws it. */
async function ownNote(noteId, admin) {
  const n = await db.one(`SELECT n.*, v.reg_no FROM vehicle_notes n JOIN vehicles v ON v.id = n.vehicle_id WHERE n.id = $1`, [Number(noteId)]);
  if (!n) return { error: 'No such note.' };
  if (n.withdrawn_at) return { error: 'That note was withdrawn.' };
  if (String(n.admin_id) !== String(admin.id) && !auth.can(admin.role, 'admins')) return { error: 'Only whoever wrote a note can change it.' };
  return { n };
}

async function editNote({ noteId, body, admin, ip }) {
  const text = String(body || '').trim();
  if (!text || text.length > 4000) return { ok: false, message: 'Write a note of up to 4,000 characters.' };
  const { n, error } = await ownNote(noteId, admin);
  if (error) return { ok: false, message: error };
  if (n.body === text) return { ok: true };
  await db.tx(async (c) => {
    await c.query(`INSERT INTO vehicle_note_versions (note_id, body, admin_id) VALUES ($1, $2, $3)`, [n.id, n.body, admin.id]);
    await c.query(`UPDATE vehicle_notes SET body = $2, edited_at = now() WHERE id = $1`, [n.id, text]);
  });
  await audit(admin, ip, 'vehicle_note_edited', { reg_no: n.reg_no, vehicle_id: String(n.vehicle_id), note_id: String(n.id) });
  return { ok: true };
}

async function withdrawNote({ noteId, admin, ip }) {
  const { n, error } = await ownNote(noteId, admin);
  if (error) return { ok: false, message: error };
  await db.query(`UPDATE vehicle_notes SET withdrawn_at = now(), withdrawn_by = $2 WHERE id = $1`, [n.id, admin.id]);
  await audit(admin, ip, 'vehicle_note_withdrawn', { reg_no: n.reg_no, vehicle_id: String(n.vehicle_id), note_id: String(n.id) });
  return { ok: true };
}

async function noteVersions(noteId) {
  const { rows } = await db.query(
    `SELECT x.id, x.body, x.replaced_at, a.name AS admin FROM vehicle_note_versions x
       LEFT JOIN admin_users a ON a.id = x.admin_id WHERE x.note_id = $1 ORDER BY x.id DESC`, [Number(noteId)]);
  return { rows: rows.map((r) => ({ ...r, id: String(r.id) })) };
}

/* ─────────────────────────────── tags ─────────────────────────────── */

async function setTags({ vehicleIds, add = [], remove = [], admin, ip }) {
  const vs = await vehiclesById(ids(vehicleIds));
  const plus = [...new Set((add || []).map(tagOf).filter((t) => /^[a-z0-9_]{2,24}$/.test(t)))];
  const minus = [...new Set((remove || []).map(tagOf).filter(Boolean))];
  if (!vs.length || (!plus.length && !minus.length)) return { ok: false, message: 'Pick vehicles and a tag.' };
  await db.tx(async (c) => {
    for (const v of vs) {
      for (const t of plus) {
        await c.query(`INSERT INTO vehicle_tags (vehicle_id, tag, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [v.id, t, admin.id]);
      }
      if (minus.length) await c.query(`DELETE FROM vehicle_tags WHERE vehicle_id = $1 AND tag = ANY($2::text[])`, [v.id, minus]);
    }
  });
  for (const v of vs) {
    await audit(admin, ip, 'vehicle_tags_changed', { reg_no: v.reg_no, vehicle_id: String(v.id), added: plus, removed: minus });
  }
  return { ok: true, vehicles: vs.length };
}

/* ─────────────────────────────── lists ─────────────────────────────── */

async function lists() {
  const { rows } = await db.query(
    `SELECT l.id, l.name, l.notes, l.created_at, l.modified_at, a.name AS created_by,
            (SELECT count(*)::int FROM vehicle_list_items i WHERE i.list_id = l.id) AS vehicles
       FROM vehicle_lists l LEFT JOIN admin_users a ON a.id = l.created_by
      WHERE l.deleted_at IS NULL ORDER BY l.modified_at DESC`);
  return { rows: rows.map((r) => ({ ...r, id: String(r.id) })) };
}

async function saveList({ id, name, notes, admin, ip }) {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) return { ok: false, message: 'Give the list a name.' };
  const note = notes == null ? null : String(notes).slice(0, 2000);
  if (id) {
    const r = await db.one(`UPDATE vehicle_lists SET name = $2, notes = $3, modified_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [Number(id), n, note]);
    if (!r) return { ok: false, message: 'No such list.' };
    await audit(admin, ip, 'vehicle_list_changed', { list_id: String(id), name: n });
    return { ok: true, id: String(r.id) };
  }
  const r = await db.one(`INSERT INTO vehicle_lists (name, notes, created_by) VALUES ($1, $2, $3) RETURNING id`, [n, note, admin.id]);
  await audit(admin, ip, 'vehicle_list_created', { list_id: String(r.id), name: n });
  return { ok: true, id: String(r.id) };
}

/* A list is set aside, not destroyed: its rows stay for the audit trail. */
async function deleteList({ id, admin, ip }) {
  const r = await db.one(`UPDATE vehicle_lists SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING name`, [Number(id)]);
  if (!r) return { ok: false, message: 'No such list.' };
  await audit(admin, ip, 'vehicle_list_deleted', { list_id: String(id), name: r.name });
  return { ok: true };
}

async function listItems({ listId, vehicleIds, action, note, admin, ip }) {
  const list = await db.one(`SELECT id, name FROM vehicle_lists WHERE id = $1 AND deleted_at IS NULL`, [Number(listId)]);
  if (!list) return { ok: false, message: 'No such list.' };
  const vs = await vehiclesById(ids(vehicleIds));
  if (!vs.length) return { ok: false, message: 'Pick vehicles.' };
  await db.tx(async (c) => {
    for (const v of vs) {
      if (action === 'remove') await c.query(`DELETE FROM vehicle_list_items WHERE list_id = $1 AND vehicle_id = $2`, [list.id, v.id]);
      else {
        await c.query(`INSERT INTO vehicle_list_items (list_id, vehicle_id, note, added_by) VALUES ($1, $2, $3, $4)
                       ON CONFLICT (list_id, vehicle_id) DO UPDATE SET note = coalesce(EXCLUDED.note, vehicle_list_items.note)`,
        [list.id, v.id, note ? String(note).slice(0, 500) : null, admin.id]);
      }
    }
    await c.query(`UPDATE vehicle_lists SET modified_at = now() WHERE id = $1`, [list.id]);
  });
  for (const v of vs) {
    await audit(admin, ip, action === 'remove' ? 'vehicle_list_removed' : 'vehicle_list_added',
      { reg_no: v.reg_no, vehicle_id: String(v.id), list_id: String(list.id), list: list.name });
  }
  return { ok: true, vehicles: vs.length };
}

/* ─────────────────────────── assign / archive ─────────────────────────── */

async function assign({ vehicleIds, adminId, admin, ip }) {
  const vs = await vehiclesById(ids(vehicleIds));
  const to = adminId ? await db.one(`SELECT id, name FROM admin_users WHERE id = $1 AND is_active`, [Number(adminId)]) : null;
  if (!vs.length) return { ok: false, message: 'Pick vehicles.' };
  if (adminId && !to) return { ok: false, message: 'No such active panel user.' };
  for (const v of vs) {
    await db.query(`INSERT INTO vehicle_admin (vehicle_id, assigned_to, assigned_by, assigned_at) VALUES ($1, $2, $3, now())
                    ON CONFLICT (vehicle_id) DO UPDATE SET assigned_to = $2, assigned_by = $3, assigned_at = now()`,
    [v.id, to ? to.id : null, admin.id]);
    await audit(admin, ip, 'vehicle_assigned', { reg_no: v.reg_no, vehicle_id: String(v.id), to: to ? to.name : null });
  }
  return { ok: true, vehicles: vs.length };
}

async function archive({ vehicleIds, archived, admin, ip }) {
  const vs = await vehiclesById(ids(vehicleIds));
  if (!vs.length) return { ok: false, message: 'Pick vehicles.' };
  for (const v of vs) {
    await db.query(`INSERT INTO vehicle_admin (vehicle_id, archived_at, archived_by) VALUES ($1, CASE WHEN $2 THEN now() END, $3)
                    ON CONFLICT (vehicle_id) DO UPDATE SET archived_at = CASE WHEN $2 THEN now() END, archived_by = $3`,
    [v.id, Boolean(archived), admin.id]);
    await audit(admin, ip, archived ? 'vehicle_archived' : 'vehicle_unarchived', { reg_no: v.reg_no, vehicle_id: String(v.id) });
  }
  return { ok: true, vehicles: vs.length };
}

/* ─────────────────────────────── preferences ─────────────────────────────── */

async function getPref(admin, key) {
  const r = await db.one(`SELECT value FROM admin_preferences WHERE admin_id = $1 AND key = $2`, [admin.id, String(key)]);
  return { value: r ? r.value : null };
}
async function setPref(admin, key, value) {
  if (!/^[a-z0-9_.-]{1,60}$/.test(String(key))) return { ok: false, message: 'Bad key.' };
  const json = JSON.stringify(value ?? null);
  if (json.length > 20000) return { ok: false, message: 'Too large.' };
  await db.query(`INSERT INTO admin_preferences (admin_id, key, value) VALUES ($1, $2, $3::jsonb)
                  ON CONFLICT (admin_id, key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [admin.id, key, json]);
  return { ok: true };
}

/* ─────────────────────────────── meta ─────────────────────────────── */

async function meta() {
  const [admins, tags, ls, makers] = await Promise.all([
    db.query(`SELECT id, name, role FROM admin_users WHERE is_active ORDER BY name`),
    db.query(`SELECT tag, count(*)::int AS n FROM vehicle_tags GROUP BY 1 ORDER BY 2 DESC, 1`),
    lists(),
    db.query(`SELECT DISTINCT maker FROM vehicles WHERE maker IS NOT NULL ORDER BY 1 LIMIT 300`),
  ]);
  const used = tags.rows.map((t) => t.tag);
  return {
    admins: admins.rows.map((a) => ({ ...a, id: String(a.id) })),
    tags: [...new Set([...TAGS, ...used])].map((t) => ({ tag: t, n: tags.rows.find((x) => x.tag === t)?.n || 0 })),
    lists: ls.rows, makers: makers.rows.map((m) => m.maker),
    soon_days: await settings.num('vehicle_expiring_days', 30),
  };
}

/* ─────────────────────────────── intelligence ─────────────────────────────── */

const LOOKUP = `e.name IN ('vehicle_search_success', 'vehicle_search_failed') AND e.reg_no IS NOT NULL`;
const PERSON = `coalesce(e.mobile, u.mobile)`;

async function intel(q = {}) {
  const r = command.resolve({ range: q.range || '30d', from: q.from, to: q.to, compare: 'none' });
  const a = [r.from, r.to];
  const within = `e.occurred_at >= $1 AND e.occurred_at < $2`;
  const [vehicles, rtos, makers, models, perPerson, perVehicle] = await Promise.all([
    db.query(`SELECT e.reg_no, count(*)::int AS n, count(DISTINCT ${PERSON})::int AS people, max(e.occurred_at) AS last
                FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE ${LOOKUP} AND ${within}
               GROUP BY 1 ORDER BY 2 DESC, 4 DESC LIMIT 15`, a),
    db.query(`SELECT CASE WHEN e.reg_no ~ '^[A-Z]{2}[0-9]{2}' THEN substring(e.reg_no from 1 for 4) ELSE substring(e.reg_no from 1 for 2) END AS name,
                     count(*)::int AS n FROM events e WHERE ${LOOKUP} AND ${within} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, a),
    db.query(`SELECT coalesce(v.maker, 'Not available') AS name, count(*)::int AS n FROM events e LEFT JOIN vehicles v ON v.reg_no = e.reg_no
               WHERE ${LOOKUP} AND ${within} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, a),
    db.query(`SELECT coalesce(v.model, 'Not available') AS name, count(*)::int AS n FROM events e LEFT JOIN vehicles v ON v.reg_no = e.reg_no
               WHERE ${LOOKUP} AND ${within} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, a),
    db.query(`SELECT ${PERSON} AS person, max(e.user_id) AS user_id, count(DISTINCT e.reg_no)::int AS vehicles, count(*)::int AS n
                FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE ${LOOKUP} AND ${within} AND ${PERSON} IS NOT NULL
               GROUP BY 1 HAVING count(DISTINCT e.reg_no) >= 2 ORDER BY 3 DESC LIMIT 15`, a),
    db.query(`SELECT e.reg_no, count(DISTINCT ${PERSON})::int AS people, count(*)::int AS n
                FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE ${LOOKUP} AND ${within}
               GROUP BY 1 HAVING count(DISTINCT ${PERSON}) >= 2 ORDER BY 2 DESC LIMIT 15`, a),
  ]);
  const veh = (x) => ({ reg_no: x.reg_no, display: plate.pretty(x.reg_no) });
  return {
    range: { label: r.label },
    most_searched: vehicles.rows.map((x) => ({ ...veh(x), n: x.n, people: x.people, last: x.last })),
    repeated: vehicles.rows.filter((x) => x.n >= 2).map((x) => ({ ...veh(x), n: x.n, people: x.people })),
    rtos: rtos.rows, makers: makers.rows, models: models.rows,
    person_many_vehicles: perPerson.rows.map((x) => ({ customer: maskMobile(x.person), ref: x.user_id ? `u${x.user_id}` : null, vehicles: x.vehicles, n: x.n })),
    vehicle_many_people: perVehicle.rows.map((x) => ({ ...veh(x), people: x.people, n: x.n })),
  };
}

/*
 * Patterns worth a look. Each says what it saw and why it is listed — never
 * that anyone did anything wrong — and none of them blocks, bans or deletes.
 * Thresholds live in settings so they can be tuned without a release.
 */
async function signals(q = {}) {
  const r = command.resolve({ range: q.range || '7d', from: q.from, to: q.to, compare: 'none' });
  const a = [r.from, r.to];
  const within = `e.occurred_at >= $1 AND e.occurred_at < $2`;
  const [perDay, perHour, device, failures, api] = await Promise.all([
    settings.num('signal_vehicles_per_person_day', 10),
    settings.num('signal_lookups_per_vehicle_hour', 5),
    settings.num('signal_mobiles_per_device', 2),
    settings.num('signal_payment_failures_day', 3),
    settings.num('signal_api_calls_per_person_hour', 30),
  ]);
  const [many, repeat, shared, payFail, apiHeavy] = await Promise.all([
    db.query(`SELECT ${PERSON} AS person, max(e.user_id) AS user_id, date_trunc('day', e.occurred_at AT TIME ZONE 'Asia/Kolkata') AS day,
                     count(DISTINCT e.reg_no)::int AS vehicles, max(e.occurred_at) AS at, (array_agg(DISTINCT e.reg_no))[1:5] AS sample
                FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE ${LOOKUP} AND ${within} AND ${PERSON} IS NOT NULL
               GROUP BY 1, 3 HAVING count(DISTINCT e.reg_no) >= $3 ORDER BY 5 DESC LIMIT 100`, [...a, perDay]),
    db.query(`SELECT e.reg_no, date_trunc('hour', e.occurred_at) AS hour, count(*)::int AS n, count(DISTINCT ${PERSON})::int AS people,
                     max(e.occurred_at) AS at, max(${PERSON}) AS person, max(e.user_id) AS user_id
                FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE ${LOOKUP} AND ${within}
               GROUP BY 1, 2 HAVING count(*) >= $3 ORDER BY 5 DESC LIMIT 100`, [...a, perHour]),
    db.query(`SELECT e.visitor_id, count(DISTINCT ${PERSON})::int AS mobiles, max(e.occurred_at) AS at, (array_agg(DISTINCT ${PERSON}))[1:5] AS people
                FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.visitor_id IS NOT NULL AND ${within} AND ${PERSON} IS NOT NULL
               GROUP BY 1 HAVING count(DISTINCT ${PERSON}) >= $3 ORDER BY 3 DESC LIMIT 100`, [...a, device]),
    db.query(`SELECT p.user_id, u.mobile, date_trunc('day', p.created_at AT TIME ZONE 'Asia/Kolkata') AS day, count(*)::int AS n,
                     max(p.created_at) AS at, max(p.id) AS payment_id, max(v.reg_no) AS reg_no
                FROM payments p LEFT JOIN users u ON u.id = p.user_id
                LEFT JOIN vehicles v ON p.raw ? 'vehicle_id' AND v.id::text = p.raw->>'vehicle_id'
               WHERE p.status = 'failed' AND p.created_at >= $1 AND p.created_at < $2
               GROUP BY 1, 2, 3 HAVING count(*) >= $3 ORDER BY 5 DESC LIMIT 100`, [...a, failures]),
    db.query(`SELECT a.user_id, u.mobile, date_trunc('hour', a.created_at) AS hour, count(*)::int AS n, max(a.created_at) AS at, max(a.reg_no) AS reg_no
                FROM api_calls a LEFT JOIN users u ON u.id = a.user_id
               WHERE NOT a.cache_hit AND a.user_id IS NOT NULL AND a.created_at >= $1 AND a.created_at < $2
               GROUP BY 1, 2, 3 HAVING count(*) >= $3 ORDER BY 5 DESC LIMIT 100`, [...a, api]),
  ]);
  const who = (mobile, userId) => ({ customer: maskMobile(mobile), ref: userId ? `u${userId}` : null });
  const rows = [
    ...many.rows.map((x) => ({ kind: 'person_many_vehicles', signal: 'One number, many vehicles',
      reason: `${x.vehicles} different vehicles looked up in one day (threshold ${perDay}).`, at: x.at, ...who(x.person, x.user_id),
      vehicle: x.sample?.[0] || null, vehicles: x.sample || [] })),
    ...repeat.rows.map((x) => ({ kind: 'vehicle_repeated', signal: 'Same vehicle, again and again',
      reason: `Looked up ${x.n} times within an hour by ${x.people} ${x.people === 1 ? 'person' : 'people'} (threshold ${perHour}).`,
      at: x.at, ...who(x.people === 1 ? x.person : null, x.people === 1 ? x.user_id : null), vehicle: x.reg_no })),
    ...shared.rows.map((x) => ({ kind: 'device_many_mobiles', signal: 'One browser, several numbers',
      reason: `${x.mobiles} different WhatsApp numbers linked to the same website browser (threshold ${device}).`,
      at: x.at, customer: (x.people || []).map(maskMobile).join(', '), ref: null, vehicle: null, device: `${x.visitor_id.slice(0, 6)}…` })),
    ...payFail.rows.map((x) => ({ kind: 'payment_failures', signal: 'Repeated payment failures',
      reason: `${x.n} failed payments in one day (threshold ${failures}).`, at: x.at, ...who(x.mobile, x.user_id),
      vehicle: x.reg_no, payment: x.payment_id ? String(x.payment_id) : null })),
    ...apiHeavy.rows.map((x) => ({ kind: 'api_heavy', signal: 'Many records-API calls',
      reason: `${x.n} live records-API calls in one hour (threshold ${api}).`, at: x.at, ...who(x.mobile, x.user_id), vehicle: x.reg_no })),
  ].sort((p, q2) => new Date(q2.at) - new Date(p.at));
  return {
    range: { label: r.label }, rows,
    thresholds: { vehicles_per_person_day: perDay, lookups_per_vehicle_hour: perHour, mobiles_per_device: device,
                  payment_failures_day: failures, api_calls_per_person_hour: api },
    note: 'Signals are patterns, not findings. Nothing is blocked or changed because of them.',
  };
}

/* ─────────────────────────────── live ─────────────────────────────── */

const LIVE_NAMES = ['vehicle_search_success', 'vehicle_search_failed', 'whatsapp_vehicle_received', 'vehicle_api_success',
  'vehicle_api_failed', 'report_preview_viewed', 'report_generated', 'report_delivered', 'payment_started', 'payment_success', 'payment_failed'];
const LIVE_LABEL = {
  vehicle_search_success: 'Vehicle lookup — found', vehicle_search_failed: 'Vehicle lookup — not found',
  whatsapp_vehicle_received: 'Vehicle number received on WhatsApp', vehicle_api_success: 'Records API answered',
  vehicle_api_failed: 'Records API failed', report_preview_viewed: 'Full report requested', report_generated: 'Report generated',
  report_delivered: 'Report delivered', payment_started: 'Payment link sent', payment_success: 'Payment successful', payment_failed: 'Payment failed',
};

async function live({ since } = {}) {
  const after = Number(since) || 0;
  const { rows } = await db.query(
    `SELECT e.id, e.occurred_at, e.name, e.channel, coalesce(e.reg_no, v.reg_no) AS reg_no, coalesce(e.mobile, u.mobile) AS person,
            e.status, e.duration_ms, e.amount_paise
       FROM events e LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN payments p ON p.id = e.payment_id
       LEFT JOIN vehicles v ON p.raw ? 'vehicle_id' AND v.id::text = p.raw->>'vehicle_id'
      WHERE e.name = ANY($1::text[]) AND e.id > $2
        AND e.occurred_at > now() - interval '24 hours'
      ORDER BY e.id DESC LIMIT 60`, [LIVE_NAMES, after]);
  return {
    cursor: rows[0] ? String(rows[0].id) : String(after),
    rows: rows.map((e) => ({ id: String(e.id), at: e.occurred_at, name: e.name, label: LIVE_LABEL[e.name] || e.name,
      channel: e.channel, reg_no: e.reg_no, display: e.reg_no ? plate.pretty(e.reg_no) : null, customer: maskMobile(e.person),
      duration_ms: e.duration_ms, amount_paise: e.amount_paise })),
  };
}

/* ─────────────────────────────── API logs ─────────────────────────────── */

async function apiLogs(q = {}) {
  const r = command.resolve({ range: q.range || '7d', from: q.from, to: q.to, compare: 'none' });
  const args = [r.from, r.to]; const w = ['a.created_at >= $1', 'a.created_at < $2'];
  const bind = (v) => { args.push(v); return `$${args.length}`; };
  if (q.q) w.push(`a.reg_no LIKE ${bind(`%${plate.normalize(q.q)}%`)}`);
  if (q.dataset) w.push(`a.dataset = ${bind(String(q.dataset))}`);
  if (q.ok === '0') w.push('NOT a.ok');
  if (q.ok === '1') w.push('a.ok');
  if (q.cache === '0') w.push('NOT a.cache_hit');
  if (q.cache === '1') w.push('a.cache_hit');
  const limit = Math.min(200, Number(q.limit) || 50); const offset = Math.max(0, Number(q.offset) || 0);
  const { rows } = await db.query(
    `SELECT a.id, a.created_at, a.reg_no, a.dataset, a.provider_path, a.cache_hit, a.http_status, a.ok, a.outcome,
            a.error_code, a.error_message, a.duration_ms, a.cost_paise, count(*) OVER () AS total_rows
       FROM api_calls a WHERE ${w.join(' AND ')} ORDER BY a.id DESC LIMIT ${limit} OFFSET ${offset}`, args);
  const { redact } = module.exports;
  return {
    range: { label: r.label }, total: rows[0] ? Number(rows[0].total_rows) : 0,
    rows: rows.map(({ total_rows, ...x }) => ({ ...x, id: String(x.id), display: x.reg_no ? plate.pretty(x.reg_no) : null,
      error_message: x.error_message ? redact(x.error_message) : null })),
  };
}
/* Tokens never leave, even inside an error message. */
const redact = (s) => String(s).replace(/(bearer\s+)[\w.-]+/gi, '$1[hidden]').replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[hidden]');

module.exports = {
  addNote, editNote, withdrawNote, noteVersions, setTags, lists, saveList, deleteList, listItems,
  assign, archive, getPref, setPref, meta, intel, signals, live, apiLogs, redact, TAGS,
};
