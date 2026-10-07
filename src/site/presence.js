/**
 * src/site/presence.js — who is on gaadipe.in right now, and on what
 * (user, 2026-10-07; migration 126, the web admin's Live users).
 *
 *   touch(visit)          a heartbeat, page view or interaction: the visit's row in
 *                         web_sessions is created or brought up to date
 *   monitoringOff(ids)    is the OPTIONAL interaction telemetry switched off for
 *                         this session, customer, browser, or everywhere?
 *   statusOf(row)         ONLINE / IDLE / HIDDEN / OFFLINE / ENDED, from the times
 *
 * Never in a customer's way: every function here swallows its own failure.
 */

const db = require('../db');
const settings = require('../util/settings');

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/* The live monitoring switches, read at most every 15 s. */
let controls = { at: 0, rows: [] };
async function openControls() {
  if (Date.now() - controls.at < 15000) return controls.rows;
  try {
    const { rows } = await db.query(`SELECT scope, ref FROM monitoring_controls WHERE lifted_at IS NULL AND disabled`);
    controls = { at: Date.now(), rows };
  } catch { /* keep the last answer */ }
  return controls.rows;
}
const clearControls = () => { controls.at = 0; };

async function monitoringOff({ sessionId, visitorId, userId } = {}) {
  if (String(await settings.get('web_monitoring', 'on')).toLowerCase() === 'off') return 'global';
  for (const c of await openControls()) {
    if (c.scope === 'global') return 'global';
    if (c.scope === 'session' && c.ref === sessionId) return 'session';
    if (c.scope === 'device' && c.ref === visitorId) return 'device';
    if (c.scope === 'customer' && userId && c.ref === String(userId)) return 'customer';
  }
  return null;
}

/**
 * One visit's row brought up to date. `kind` is heartbeat | page | interaction | start.
 * Returns { userId, monitoring: 'on' | 'off', ended } — ended when an admin ended the visit.
 */
async function touch({ kind, sessionId, visitorId, page, step, section, scroll, visible, action, source, campaign, landing, device, place, deviceKey }) {
  try {
    const isAction = kind === 'interaction';
    const row = await db.one(
      `INSERT INTO web_sessions AS w (session_id, visitor_id, user_id, page, step, section, scroll_pct, visible, action,
                                      last_action_at, pages, interactions, beats, source, campaign, landing, device, place)
       VALUES ($1, $2, (SELECT user_id FROM visitors WHERE visitor_id = $2), $3, $4, $5, $6, coalesce($7, true), $8,
               CASE WHEN $9 THEN now() END, CASE WHEN $10 = 'page' THEN 1 ELSE 0 END, CASE WHEN $9 THEN 1 ELSE 0 END,
               CASE WHEN $10 = 'heartbeat' THEN 1 ELSE 0 END, $11, $12, $13, $14::jsonb, $15::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET
         user_id        = coalesce((SELECT user_id FROM visitors WHERE visitor_id = w.visitor_id), w.user_id),
         last_seen_at   = now(),
         page           = coalesce(EXCLUDED.page, w.page),
         step           = coalesce(EXCLUDED.step, w.step),
         section        = coalesce(EXCLUDED.section, w.section),
         scroll_pct     = coalesce(EXCLUDED.scroll_pct, w.scroll_pct),
         visible        = coalesce($7, w.visible),
         action         = CASE WHEN $9 THEN EXCLUDED.action ELSE w.action END,
         last_action_at = CASE WHEN $9 THEN now() ELSE w.last_action_at END,
         pages          = w.pages + CASE WHEN $10 = 'page' THEN 1 ELSE 0 END,
         interactions   = w.interactions + CASE WHEN $9 THEN 1 ELSE 0 END,
         beats          = w.beats + CASE WHEN $10 = 'heartbeat' THEN 1 ELSE 0 END,
         source         = coalesce(w.source, EXCLUDED.source),
         campaign       = coalesce(w.campaign, EXCLUDED.campaign),
         landing        = coalesce(w.landing, EXCLUDED.landing),
         device         = CASE WHEN w.device = '{}'::jsonb THEN EXCLUDED.device ELSE w.device END,
         place          = CASE WHEN w.place = '{}'::jsonb THEN EXCLUDED.place ELSE w.place END,
         device_key     = coalesce($16, w.device_key)
       RETURNING user_id, ended_at, end_reason`,
      [clip(sessionId, 64), clip(visitorId, 64), clip(page, 300), clip(step, 40), clip(section, 80),
       Number.isFinite(Number(scroll)) && scroll !== null && scroll !== '' ? Math.max(0, Math.min(100, Math.round(Number(scroll)))) : null,
       typeof visible === 'boolean' ? visible : null, clip(action, 120), isAction, kind,
       clip(source, 60), clip(campaign, 120), clip(landing, 200), JSON.stringify(device || {}), JSON.stringify(place || {}),
       /^gp-[A-Za-z0-9-]{6,64}$/.test(String(deviceKey || '')) ? String(deviceKey) : null]);
    /* A CUSTOMER ON THE WEBSITE IS A CUSTOMER SEEN (2026-10-07: "in Customers I
       don't see who just came"). Only a WhatsApp message used to move
       users.last_seen_at, so website customers sank in the list. At most once a
       minute per customer. */
    if (row?.user_id) {
      await db.query(`UPDATE users SET last_seen_at = now()
                       WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`, [row.user_id])
        .catch(() => {});
    }
    const off = await monitoringOff({ sessionId, visitorId, userId: row?.user_id });
    const scrollOn = String(await settings.get('web_track_scroll', 'on')).toLowerCase() !== 'off' && !off;
    return { userId: row?.user_id ? String(row.user_id) : null, monitoring: off ? 'off' : 'on', offBy: off, scroll: scrollOn, ended: row?.end_reason === 'terminated' };
  } catch (e) {
    console.error('[presence] %s', e.message);
    return { userId: null, monitoring: 'on', ended: false };
  }
}

/* ONLINE / IDLE / HIDDEN / OFFLINE / ENDED — from the row's own times (spec §83). */
function statusOf(r, { idleS = 60, offlineS = 75, now = Date.now() } = {}) {
  if (r.ended_at) return r.end_reason === 'terminated' ? 'TERMINATED' : 'ENDED';
  const seen = (now - new Date(r.last_seen_at).getTime()) / 1000;
  if (seen > offlineS) return 'OFFLINE';
  if (r.visible === false) return 'HIDDEN';
  // Heartbeats keep a tab "seen"; only a real tap keeps it ONLINE. Before the first tap, arriving counts.
  const acted = (now - new Date(r.last_action_at || r.started_at).getTime()) / 1000;
  return acted > idleS ? 'IDLE' : 'ONLINE';
}

module.exports = { touch, monitoringOff, statusOf, clearControls };
