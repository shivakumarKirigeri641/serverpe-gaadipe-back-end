/**
 * src/site/activity.js — the trail of a signed-in customer on the site.
 *
 * Pages are reported by the site itself (it is the only one that knows the
 * route); actions that reach the server — a check, a buy, a download — are
 * recorded here by the route that handles them, so they cannot be skipped or
 * invented by a page.
 *
 * Recording must never break the request it describes: every write swallows
 * its own error.
 */

const db = require('../db');
const plate = require('../util/plate');
const settings = require('../util/settings');

const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

/* What the site may report. Anything else is dropped rather than stored. */
const CLIENT_ACTIONS = new Set([
  'buy_open', 'buy_close', 'pay_start', 'pay_cancel', 'share', 'print',
  'view_report', 'view_invoice', 'download_report', 'download_invoice', 'sign_out',
]);

/** A registration found in a page path, e.g. /app/vehicle/KA01AB1234. */
function regFromPage(page) {
  const m = /\/vehicle\/([^/?#]+)/.exec(page || '');
  if (!m) return null;
  const p = plate.parse(decodeURIComponent(m[1]));
  return p.ok ? p.regNo : null;
}

async function record(req, { kind = 'action', page = null, action = null, regNo = null, detail = null } = {}) {
  const sessionId = req.siteSession?.sessionId;
  if (!sessionId) return;
  page = clip(page, 300);
  action = clip(action, 60);
  regNo = clip(regNo || regFromPage(page), 20);
  try {
    // The same step twice within a few seconds (a double render, a retried
    // call) is one step, recorded once. A click is the same click only if it
    // is the same label within a second — two different buttons are two.
    const label = detail?.label ? String(detail.label) : null;
    const { rowCount } = await db.query(
      `INSERT INTO site_activity (session_id, user_id, kind, page, action, reg_no, detail, ip)
       SELECT $1::bigint, $2::bigint, $3::text, $4::text, $5::text, $6::text, $7::jsonb, $8::text
        WHERE NOT EXISTS (SELECT 1 FROM site_activity
                           WHERE session_id = $1 AND kind = $3
                             AND page IS NOT DISTINCT FROM $4 AND action IS NOT DISTINCT FROM $5
                             AND reg_no IS NOT DISTINCT FROM $6
                             AND (detail->>'label') IS NOT DISTINCT FROM $9::text
                             AND created_at > now() - CASE WHEN $3 = 'click' THEN interval '1 second'
                                                           ELSE interval '5 seconds' END)`,
      [sessionId, req.user?.id || null, kind, page, action, regNo,
       detail ? JSON.stringify(detail) : null, req.ip || null, label]);
    if (!rowCount) return;
    // The latest state. A page change keeps the vehicle only if the new page is
    // about one; an action keeps the page the visitor is on; a click keeps the
    // page and says what was clicked.
    await db.query(
      `UPDATE site_sessions
          SET current_page   = coalesce($2, current_page),
              current_reg_no = CASE WHEN $2::text IS NOT NULL THEN $3 ELSE coalesce($3, current_reg_no) END,
              current_action = CASE WHEN $2::text IS NOT NULL AND $4::text IS NULL THEN 'viewing' ELSE coalesce($4, current_action) END,
              current_detail = $5,
              current_at     = now()
        WHERE id = $1`, [sessionId, kind === 'page' ? page : null, regNo, action, kind === 'click' ? label : null]);
  } catch (e) {
    console.error('[activity] %s', e.message);
  }
}

/** What the site reported: a page view, or one of the known client actions. */
async function fromClient(req, body = {}) {
  const page = clip(body.page, 300);
  if (body.kind === 'page') {
    if (!page || !page.startsWith('/')) return false;
    await record(req, { kind: 'page', page, detail: body.title ? { title: clip(body.title, 120) } : null });
    return true;
  }
  if (body.kind === 'click') return recordClick(req, body, page);
  const action = String(body.action || '');
  if (!CLIENT_ACTIONS.has(action)) return false;
  const p = body.reg_no ? plate.parse(body.reg_no) : null;
  await record(req, { action, page, regNo: p?.ok ? p.regNo : null });
  return true;
}

/*
 * EVERY CLICK (user, 2026-09-21): what was clicked — its label and kind, and
 * where a link points — never anything typed. At most track_clicks_per_minute
 * per session, so a runaway page cannot flood the table.
 */
const ELEMENTS = new Set(['button', 'link', 'tab', 'checkbox', 'radio', 'select', 'menu', 'other']);
const perMinute = new Map();   // session -> { minute, n }

function hrefPath(href) {
  if (!href) return null;
  try {
    const u = new URL(String(href), 'https://gaadipe.in');
    // Our own pages: the path only (a query can carry a token). Elsewhere: host and path.
    return /(^|\.)gaadipe\.in$|^localhost$/.test(u.hostname) ? clip(u.pathname + (u.hash || ''), 200)
      : clip(`${u.protocol}//${u.host}${u.pathname}`, 200);
  } catch { return null; }
}

async function recordClick(req, body, page) {
  if (String(await settings.get('track_clicks', 'true')).toLowerCase() === 'false') return false;
  const sid = req.siteSession?.sessionId;
  if (!sid) return false;
  const minute = Math.floor(Date.now() / 60000);
  const cap = await settings.num('track_clicks_per_minute', 120);
  const c = perMinute.get(sid);
  if (c && c.minute === minute && c.n >= cap) return false;
  perMinute.set(sid, c && c.minute === minute ? { minute, n: c.n + 1 } : { minute, n: 1 });
  if (perMinute.size > 5000) perMinute.clear();

  const label = clip(String(body.label || '').replace(/\s+/g, ' ').trim(), 80);
  if (!label && !body.href) return false;
  const el = ELEMENTS.has(body.el) ? body.el : 'other';
  await record(req, { kind: 'click', page, action: 'click',
    detail: { label: label || null, el, href: hrefPath(body.href) } });
  return true;
}

/** History older than activity_retention_days (180) is deleted, as the privacy policy says. */
async function prune() {
  const days = Math.max(7, await settings.num('activity_retention_days', 180));
  const r = await db.query(`DELETE FROM site_activity WHERE created_at < now() - ($1 || ' days')::interval`, [String(days)]);
  if (r.rowCount) console.log('[activity] pruned %d entries older than %d days', r.rowCount, days);
  return r.rowCount;
}

module.exports = { record, fromClient, regFromPage, prune };
