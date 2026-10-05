/**
 * src/admin/broadcastPlans.js — BROADCAST IN BATCHES (user, 2026-10-05).
 *
 * While the WhatsApp messaging limit is 250 people in any 24 hours — shared
 * with QuizPe and with GaadiPe's own alerts — a message to everyone has to go
 * in parts. A plan holds the whole audience and sends it batch by batch:
 *
 *   each batch  = at most batch_size people, and never more than the room
 *                 left in the last 24 hours (limit − already messaged − reserve)
 *   next batch  = gap_hours after the previous one finished (24 by default,
 *                 so the earlier batch has left the 24-hour window)
 *   who         = everyone in the plan not yet reached by it. Someone whose
 *                 send failed (refused at the limit, say) is tried again in a
 *                 later batch — at most twice; STOP and blocks are skipped by
 *                 the sender itself and are not retried.
 *
 * Every batch is an ordinary broadcast (admin/broadcasts.js queue), sent by
 * the broadcast job like any other, and listed with the others.
 */

const db = require('../db');
const settings = require('../util/settings');
const broadcasts = require('./broadcasts');

const clean = (m) => String(m || '').replace(/\D/g, '').slice(-10);

/** People messaged first by GaadiPe in the last 24 hours, and the limit. */
async function room() {
  const limit = await settings.num('whatsapp_messaging_limit', 250);
  const r = await db.one(
    `SELECT count(DISTINCT mobile)::int AS used FROM whatsapp_messages
      WHERE direction = 'out' AND message_type = 'template' AND created_at > now() - interval '24 hours'
        AND coalesce(error_message, '') = ''`);
  return { limit, used: r.used };
}

/** Where each person of a plan stands: reached, waiting in a batch, or tries used. */
async function progress(plan) {
  const ids = (plan.broadcast_ids || []).map(Number).filter(Boolean);
  const { rows } = ids.length ? await db.query(
    `SELECT mobile,
            bool_or(status = 'sent') AS sent,
            bool_or(status = 'pending' OR (status = 'failed' AND attempts < 3)) AS waiting,
            bool_or(status = 'skipped') AS skipped,
            count(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM whatsapp_broadcast_targets WHERE broadcast_id = ANY($1::bigint[]) GROUP BY mobile`, [ids]) : { rows: [] };
  const by = new Map(rows.map((r) => [r.mobile, r]));
  const all = (plan.mobiles || []).map(clean);
  const sent = all.filter((m) => by.get(m)?.sent);
  const waiting = all.filter((m) => !by.get(m)?.sent && by.get(m)?.waiting);
  const skipped = all.filter((m) => !by.get(m)?.sent && !by.get(m)?.waiting && by.get(m)?.skipped);
  const gaveUp = all.filter((m) => !by.get(m)?.sent && !by.get(m)?.waiting && !by.get(m)?.skipped && (by.get(m)?.failed || 0) >= 2);
  const left = all.filter((m) => !by.get(m)?.sent && !by.get(m)?.waiting && !by.get(m)?.skipped && (by.get(m)?.failed || 0) < 2);
  return { total: all.length, sent: sent.length, waiting: waiting.length, skipped: skipped.length, gave_up: gaveUp.length, left };
}

/**
 * Make a plan. The first batch goes on the next tick (within five minutes),
 * or at `start_at`. Checked like a broadcast before anything is saved.
 */
async function create({ template_name, language = 'en', variables = [], mobiles = [], note = '',
                        batch_size = 150, gap_hours = 24, reserve = 50, start_at = null }, adminId) {
  const people = [...new Set((mobiles || []).map(clean).filter((m) => m.length === 10))];
  if (!people.length) return { ok: false, message: 'Choose at least one customer.' };
  const check = await broadcasts.preview({ template_name, language, variables, mobiles: people.slice(0, 5) });
  if (!check.ok) return check;
  const size = Math.round(Number(batch_size));
  const gap = Number(gap_hours);
  const keep = Math.round(Number(reserve));
  if (!Number.isInteger(size) || size < 1 || size > 2000) return { ok: false, message: 'A batch is 1 to 2,000 people.' };
  if (!Number.isFinite(gap) || gap < 1 || gap > 168) return { ok: false, message: 'The gap is 1 to 168 hours.' };
  if (!Number.isInteger(keep) || keep < 0 || keep > 2000) return { ok: false, message: 'Keep free 0 to 2,000.' };
  const at = start_at && !Number.isNaN(Date.parse(start_at)) ? new Date(start_at) : new Date();
  const row = await db.one(
    `INSERT INTO broadcast_plans (admin_id, template_name, language, variables, note, mobiles, batch_size, gap_hours, reserve, next_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10) RETURNING id`,
    [adminId || null, template_name, language, JSON.stringify(variables || []), String(note || '').slice(0, 300),
     JSON.stringify(people), size, gap, keep, at.toISOString()]);
  await require('./auth').audit({ adminId, action: 'broadcast_plan_created',
    detail: { plan: String(row.id), template_name, people: people.length, batch_size: size, gap_hours: gap, reserve: keep } });
  // Not waiting five minutes for a plan that starts now.
  if (at <= new Date()) setTimeout(() => tick().catch((e) => console.error('[plans] first tick:', e.message)), 1000);
  return { ok: true, id: String(row.id), people: people.length, batches: Math.ceil(people.length / size) };
}

/** Send the next batch of every plan that is due. Called every five minutes (app.js). */
async function tick() {
  const { rows } = await db.query(
    `SELECT * FROM broadcast_plans WHERE status = 'running' AND next_at <= now() ORDER BY next_at LIMIT 5`);
  for (const plan of rows) {
    // Claimed first: two servers or two ticks never send the same batch.
    const mine = await db.one(
      `UPDATE broadcast_plans SET next_at = now() + interval '10 minutes', modified_at = now()
        WHERE id = $1 AND status = 'running' AND next_at <= now() RETURNING id`, [plan.id]);
    if (!mine) continue;
    try {
      await step(plan);
    } catch (e) {
      console.error('[plans] plan %s: %s', plan.id, e.message);
      await db.query(`UPDATE broadcast_plans SET last_note = $2 WHERE id = $1`, [plan.id, `Error: ${e.message}`.slice(0, 300)]);
    }
  }
}

async function step(plan) {
  const p = await progress(plan);
  if (p.waiting) {
    // The last batch is still going out: look again shortly.
    await note(plan.id, `Batch still sending — ${p.waiting} waiting.`, 15);
    return;
  }
  if (!p.left.length) {
    await db.query(
      `UPDATE broadcast_plans SET status = 'done', finished_at = now(), modified_at = now(),
              last_note = $2 WHERE id = $1`,
      [plan.id, `Done — ${p.sent} of ${p.total} reached${p.skipped ? `, ${p.skipped} skipped (STOP/blocked)` : ''}${p.gave_up ? `, ${p.gave_up} failed twice` : ''}.`]);
    return;
  }
  const r = await room();
  const free = r.limit - r.used - Number(plan.reserve || 0);
  const size = Math.min(Number(plan.batch_size), free);
  if (size < 1) {
    await note(plan.id, `Waiting for room: ${r.used} of ${r.limit} messaged in the last 24 hours (${plan.reserve} kept free).`, 60);
    return;
  }
  const batch = p.left.slice(0, size);
  const n = (plan.broadcast_ids || []).length + 1;
  const out = await broadcasts.queue({
    template_name: plan.template_name, language: plan.language, variables: plan.variables || [],
    mobiles: batch, note: `Batch ${n} of plan #${plan.id}${plan.note ? ` · ${plan.note}` : ''}`,
  }, plan.admin_id);
  if (!out.ok) {
    await note(plan.id, `Batch ${n} not sent: ${out.message || out.error}`, 60);
    return;
  }
  const remaining = p.left.length - batch.length;
  await db.query(
    `UPDATE broadcast_plans
        SET broadcast_ids = broadcast_ids || $2::jsonb, modified_at = now(),
            next_at = now() + make_interval(mins => $3::int), last_note = $4
      WHERE id = $1`,
    [plan.id, JSON.stringify([out.id]), Math.round(Number(plan.gap_hours) * 60),
     `Batch ${n}: ${batch.length} queued. ${remaining ? `${remaining} left for the next batch.` : 'That was the last batch.'}`]);
  console.log('[plans] plan %s batch %d: %d queued, %d left', plan.id, n, batch.length, remaining);
}

const note = (id, text, minutes) => db.query(
  `UPDATE broadcast_plans SET last_note = $2, next_at = now() + make_interval(mins => $3::int), modified_at = now() WHERE id = $1`,
  [id, text, minutes]);

/** Every plan, newest first, with where it stands. */
async function list() {
  const { rows } = await db.query(`SELECT * FROM broadcast_plans ORDER BY id DESC LIMIT 50`);
  const out = [];
  for (const r of rows) {
    const p = await progress(r);
    out.push({
      id: String(r.id), template_name: r.template_name, language: r.language, note: r.note,
      batch_size: r.batch_size, gap_hours: Number(r.gap_hours), reserve: r.reserve, status: r.status,
      next_at: r.next_at, created_at: r.created_at, finished_at: r.finished_at, last_note: r.last_note,
      batches: (r.broadcast_ids || []).length, broadcast_ids: (r.broadcast_ids || []).map(String),
      total: p.total, sent: p.sent, waiting: p.waiting, skipped: p.skipped, gave_up: p.gave_up, left: p.left.length,
    });
  }
  return { rows: out, room: await room() };
}

/** pause | resume | cancel. A batch already queued keeps going; cancel it on Broadcast if needed. */
async function act(id, action, adminId) {
  const to = { pause: 'paused', resume: 'running', cancel: 'cancelled' }[action];
  if (!to) return { ok: false, message: 'Unknown action.' };
  const { rowCount } = await db.query(
    `UPDATE broadcast_plans SET status = $2, modified_at = now(),
            next_at = CASE WHEN $2 = 'running' THEN greatest(next_at, now()) ELSE next_at END,
            finished_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE finished_at END
      WHERE id = $1 AND status IN ('running', 'paused')`, [id, to]);
  if (!rowCount) return { ok: false, message: 'This plan has already finished.' };
  await require('./auth').audit({ adminId, action: `broadcast_plan_${action}`, detail: { plan: String(id) } });
  return { ok: true };
}

module.exports = { create, tick, list, act, room, _test: { progress, step } };
