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
    // call) is one step, recorded once.
    const { rowCount } = await db.query(
      `INSERT INTO site_activity (session_id, user_id, kind, page, action, reg_no, detail, ip)
       SELECT $1::bigint, $2::bigint, $3::text, $4::text, $5::text, $6::text, $7::jsonb, $8::text
        WHERE NOT EXISTS (SELECT 1 FROM site_activity
                           WHERE session_id = $1 AND kind = $3
                             AND page IS NOT DISTINCT FROM $4 AND action IS NOT DISTINCT FROM $5
                             AND reg_no IS NOT DISTINCT FROM $6
                             AND created_at > now() - interval '5 seconds')`,
      [sessionId, req.user?.id || null, kind, page, action, regNo,
       detail ? JSON.stringify(detail) : null, req.ip || null]);
    if (!rowCount) return;
    // The latest state. A page change keeps the vehicle only if the new page is
    // about one; an action keeps the page the visitor is on.
    await db.query(
      `UPDATE site_sessions
          SET current_page   = coalesce($2, current_page),
              current_reg_no = CASE WHEN $2::text IS NOT NULL THEN $3 ELSE coalesce($3, current_reg_no) END,
              current_action = CASE WHEN $2::text IS NOT NULL AND $4::text IS NULL THEN 'viewing' ELSE coalesce($4, current_action) END,
              current_at     = now()
        WHERE id = $1`, [sessionId, kind === 'page' ? page : null, regNo, action]);
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
  const action = String(body.action || '');
  if (!CLIENT_ACTIONS.has(action)) return false;
  const p = body.reg_no ? plate.parse(body.reg_no) : null;
  await record(req, { action, page, regNo: p?.ok ? p.regNo : null });
  return true;
}

module.exports = { record, fromClient, regFromPage };
