/**
 * src/admin/tasks.js — tasks and notes for the team (user, 2026-09-25,
 * operations module phase 6).
 *
 * A task is work for someone — title, description, who, priority, due date,
 * status (open → in progress → completed / cancelled) — optionally about a
 * customer, vehicle, payment or incident. A note is a remark on a customer,
 * payment or incident; it is never edited or deleted, only withdrawn.
 * (Vehicle notes, with edit history, live in the Vehicles module.)
 */

const db = require('../db');

const TYPES = ['customer', 'vehicle', 'payment', 'incident'];
const PRIORITY = ['low', 'normal', 'high', 'urgent'];
const STATUS = ['open', 'in_progress', 'completed', 'cancelled'];

async function list(q = {}, admin) {
  const args = []; const w = [];
  const bind = (v) => { args.push(v); return `$${args.length}`; };
  if (q.status === 'active') w.push(`t.status IN ('open', 'in_progress')`);
  else if (STATUS.includes(q.status)) w.push(`t.status = ${bind(q.status)}`);
  if (q.mine === '1') w.push(`t.assigned_to = ${bind(admin.id)}`);
  if (TYPES.includes(q.entity_type)) w.push(`t.entity_type = ${bind(q.entity_type)}`);
  if (q.entity_id) w.push(`t.entity_id = ${bind(String(q.entity_id))}`);
  if (q.overdue === '1') w.push(`t.due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date AND t.status IN ('open', 'in_progress')`);
  const limit = Math.min(200, Number(q.limit) || 50); const offset = Math.max(0, Number(q.offset) || 0);
  const { rows } = await db.query(
    `SELECT t.*, a.name AS assigned_name, c.name AS created_by_name, count(*) OVER () AS total_rows
       FROM admin_tasks t LEFT JOIN admin_users a ON a.id = t.assigned_to LEFT JOIN admin_users c ON c.id = t.created_by
      ${w.length ? `WHERE ${w.join(' AND ')}` : ''}
      ORDER BY (t.status IN ('completed', 'cancelled')), array_position(ARRAY['urgent','high','normal','low'], t.priority), t.due_date NULLS LAST, t.id DESC
      LIMIT ${limit} OFFSET ${offset}`, args);
  const counts = await db.one(`SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
      count(*) FILTER (WHERE status IN ('open', 'in_progress') AND due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS overdue,
      count(*) FILTER (WHERE status IN ('open', 'in_progress') AND assigned_to = $1)::int AS mine FROM admin_tasks`, [admin.id]);
  return {
    total: rows[0] ? Number(rows[0].total_rows) : 0, counts,
    rows: rows.map(({ total_rows, ...t }) => ({ ...t, id: String(t.id), assigned_to: t.assigned_to ? String(t.assigned_to) : null })),
  };
}

function clean(b = {}) {
  const out = {};
  if (b.title !== undefined) out.title = String(b.title || '').trim().slice(0, 200);
  if (b.description !== undefined) out.description = b.description ? String(b.description).slice(0, 4000) : null;
  if (b.entity_type !== undefined) out.entity_type = TYPES.includes(b.entity_type) ? b.entity_type : null;
  if (b.entity_id !== undefined) out.entity_id = b.entity_id ? String(b.entity_id).slice(0, 60) : null;
  if (b.assigned_to !== undefined) out.assigned_to = Number(b.assigned_to) > 0 ? Number(b.assigned_to) : null;
  if (b.priority !== undefined) out.priority = PRIORITY.includes(b.priority) ? b.priority : 'normal';
  if (b.due_date !== undefined) out.due_date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due_date || '')) ? b.due_date : null;
  if (b.status !== undefined) out.status = STATUS.includes(b.status) ? b.status : undefined;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

async function create(body, admin) {
  const t = clean(body);
  if (!t.title) return { ok: false, message: 'Give the task a title.' };
  const r = await db.one(
    `INSERT INTO admin_tasks (title, description, entity_type, entity_id, assigned_to, priority, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, coalesce($6, 'normal'), $7, $8) RETURNING *`,
    [t.title, t.description || null, t.entity_type || null, t.entity_id || null, t.assigned_to || null, t.priority || null, t.due_date || null, admin.id]);
  return { ok: true, task: { ...r, id: String(r.id) } };
}

async function update(id, body) {
  const before = await db.one(`SELECT * FROM admin_tasks WHERE id = $1`, [Number(id)]);
  if (!before) return { ok: false, message: 'No such task.' };
  const t = clean(body);
  if (t.title === '') return { ok: false, message: 'A task needs a title.' };
  const keys = Object.keys(t);
  if (!keys.length) return { ok: true, task: before, before: {}, after: {} };
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  if (t.status) sets.push(`completed_at = CASE WHEN $${keys.length + 2} = 'completed' THEN now() ELSE NULL END`);
  const r = await db.one(`UPDATE admin_tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [Number(id), ...keys.map((k) => t[k]), ...(t.status ? [t.status] : [])]);
  const diff = (o) => Object.fromEntries(keys.filter((k) => String(before[k] ?? '') !== String(r[k] ?? '')).map((k) => [k, o[k] instanceof Date ? o[k].toISOString().slice(0, 10) : o[k]]));
  return { ok: true, task: { ...r, id: String(r.id) }, before: diff(before), after: diff(r) };
}

async function notes(type, id) {
  const { rows } = await db.query(
    `SELECT n.id, n.body, n.created_at, n.withdrawn_at, a.name AS admin, w.name AS withdrawn_by
       FROM entity_notes n LEFT JOIN admin_users a ON a.id = n.admin_id LEFT JOIN admin_users w ON w.id = n.withdrawn_by
      WHERE n.entity_type = $1 AND n.entity_id = $2 ORDER BY n.id DESC`, [type, String(id)]);
  return { rows: rows.map((n) => ({ ...n, id: String(n.id) })) };
}

async function addNote(type, id, body, admin) {
  if (!['customer', 'payment', 'incident'].includes(type)) return { ok: false, message: 'Notes on customers, payments and incidents; vehicle notes are on the vehicle.' };
  const text = String(body || '').trim();
  if (!text || text.length > 4000) return { ok: false, message: 'Write a note of up to 4,000 characters.' };
  const r = await db.one(`INSERT INTO entity_notes (entity_type, entity_id, admin_id, body) VALUES ($1, $2, $3, $4) RETURNING id`, [type, String(id), admin.id, text]);
  return { ok: true, id: String(r.id) };
}

async function withdrawNote(noteId, admin, canAll) {
  const n = await db.one(`SELECT * FROM entity_notes WHERE id = $1`, [Number(noteId)]);
  if (!n || n.withdrawn_at) return { ok: false, message: 'No such note.' };
  if (String(n.admin_id) !== String(admin.id) && !canAll) return { ok: false, message: 'Only whoever wrote a note can withdraw it.' };
  await db.query(`UPDATE entity_notes SET withdrawn_at = now(), withdrawn_by = $2 WHERE id = $1`, [n.id, admin.id]);
  return { ok: true, note: n };
}

/** Every note, of every kind, newest first — the "Admin notes" screen. */
async function allNotes(q = {}) {
  const limit = Math.min(200, Number(q.limit) || 50); const offset = Math.max(0, Number(q.offset) || 0);
  const { rows } = await db.query(
    `SELECT * , count(*) OVER () AS total_rows FROM (
       SELECT 'e' || n.id AS id, n.entity_type, n.entity_id, n.body, n.created_at, n.withdrawn_at, a.name AS admin
         FROM entity_notes n LEFT JOIN admin_users a ON a.id = n.admin_id
       UNION ALL
       SELECT 'v' || n.id, 'vehicle', v.reg_no, n.body, n.created_at, n.withdrawn_at, a.name
         FROM vehicle_notes n JOIN vehicles v ON v.id = n.vehicle_id LEFT JOIN admin_users a ON a.id = n.admin_id) x
     ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`);
  return { total: rows[0] ? Number(rows[0].total_rows) : 0, rows: rows.map(({ total_rows, ...x }) => x) };
}

module.exports = { list, create, update, notes, addNote, withdrawNote, allNotes, TYPES, PRIORITY, STATUS };
