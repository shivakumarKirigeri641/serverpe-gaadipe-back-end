/**
 * src/routes/adminApi.js — the JSON API behind the admin panel.
 *
 *   POST   /admin/api/session/otp      ask for a sign-in code
 *   POST   /admin/api/session/verify   exchange the code for a token
 *   GET    /admin/api/session          who am I
 *   DELETE /admin/api/session          sign out
 *
 * …and one group of routes per screen, below.
 *
 * THREE RULES HERE:
 *
 *  1. EVERY route except the two sign-in ones resolves a bearer token first. A
 *     session that has ended or gone idle answers 401 and the panel returns to
 *     its sign-in screen — handled once, centrally, in api.js on the other side.
 *
 *  2. NOTHING THROWS INTO EXPRESS. Express 4 does not catch a rejected promise
 *     from an async handler, and an unhandled rejection stops the process — so
 *     every handler is wrapped in `safe`, and the panel's problem never becomes
 *     the gateway's outage.
 *
 *  3. ANYTHING THAT CHANGES DATA, OR READS A CUSTOMER, IS AUDITED. The panel
 *     shows mobile numbers, vehicles and payments; "who saw this, and who
 *     changed that" must be answerable from the database.
 */

const express = require('express');
const fs = require('fs');
const db = require('../db');
const auth = require('../admin/auth');
const customers = require('../admin/customers');
const stats = require('../admin/stats');
const live = require('../admin/live');
const blocks = require('../admin/blocks');
const settings = require('../util/settings');
const plate = require('../util/plate');
const gateway = require('../vehicle/gateway');

const router = express.Router();

/* `next` is passed through: the gate below is middleware, not a handler, and
   swallowing it there would leave every request hanging. */
const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error('[adminApi] %s %s: %s', req.method, req.path, e.stack || e.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
});

const tokenOf = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
const ipOf = (req) => req.ip;
/* The panel re-asks every few seconds while a screen is open and marks those
   calls. Opening a record is audited once; its refreshes are not, or the audit
   trail would fill with the same read every ten seconds. */
const refreshing = (req) => req.get('x-refresh') === '1';

/* ------------------------------------------------------------- signing in */

router.post('/session/otp', safe(async (req, res) => {
  const out = await auth.requestCode({ mobile: req.body?.mobile, ip: ipOf(req) });
  res.json(out);
}));

router.post('/session/passcode', safe(async (req, res) => {
  const out = await auth.signInWithPasscode({
    passcode: req.body?.passcode, ip: ipOf(req), userAgent: req.get('user-agent'),
  });
  if (!out.ok) return res.status(out.error === 'too_many' ? 429 : 401).json(out);
  res.json(out);
}));

router.post('/session/verify', safe(async (req, res) => {
  const out = await auth.verifyCode({
    mobile: req.body?.mobile, code: req.body?.code,
    ip: ipOf(req), userAgent: req.get('user-agent'),
  });
  if (!out.ok) return res.status(401).json(out);
  res.json(out);
}));

/* --------------------------------------------------------------- the gate */

router.use(safe(async (req, res, next) => {
  const session = await auth.sessionFor(tokenOf(req));
  if (!session) {
    return res.status(401).json({ error: 'signed_out',
      message: 'Your session has ended. Please sign in again.' });
  }
  req.admin = session;
  // Mask customers' mobile numbers for roles without 'pii' (phase 7) — in
  // every JSON answer, whichever screen asked.
  if (!auth.can(session.role, 'pii')) {
    const json = res.json.bind(res);
    res.json = (body) => json(maskDeep(body));
  }
  next();
}));

/* 9886122415 -> 98******15, in any field that holds a customer's mobile. */
const MOBILE_KEYS = /^(mobile|user_mobile|phone|wa_id|requested_by|person_mobile)$/;
const maskMobile = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 ? `${d.slice(-10, -8)}******${d.slice(-2)}` : v;
};
function maskDeep(v, depth = 0) {
  if (depth > 8 || v == null || typeof v !== 'object' || v instanceof Date) return v;
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = MOBILE_KEYS.test(k) && (typeof x === 'string' || typeof x === 'number') ? maskMobile(x) : maskDeep(x, depth + 1);
  }
  return out;
}

/** Guard by what a role may do, never by the role's name. */
const needs = (capability) => (req, res, next) => {
  if (!auth.can(req.admin.role, capability)) {
    return res.status(403).json({ error: 'not_allowed',
      message: 'Your account does not have permission for that.' });
  }
  next();
};

router.get('/session', safe(async (req, res) => {
  res.json({ ok: true, user: { id: req.admin.id, name: req.admin.name,
                               mobile: req.admin.mobile, role: req.admin.role },
             // report_access: the owner's per-vehicle report switch, shown only while
             // admin_report_access_enabled is on (user, 2026-09-21).
             can: [...(auth.ROLES[req.admin.role] || []),
                   ...(auth.can(req.admin.role, 'admins') && await reportAccessOn() ? ['report_access'] : [])] });
}));

router.delete('/session', safe(async (req, res) => {
  await auth.signOut(tokenOf(req), { ip: ipOf(req) });
  res.json({ ok: true });
}));

/* -------------------------------------------------------------- the numbers */

/*
 * The home screen: what needs a person, and what happened today. The old
 * /dashboard stays — it is what the numbers page still reads.
 */
router.get('/home', safe(async (_req, res) => res.json(await require('../admin/home').everything())));

/* The Live Command Center (user, 2026-09-25): every KPI for a period against
   the one before, the whole journey as a funnel, what is happening now, and
   the rows behind any number. src/admin/command.js. */
const command = require('../admin/command');
const periodOf = (q) => ({ range: q.range, from: q.from, to: q.to, compare: q.compare });
router.get('/command/overview', safe(async (req, res) => res.json(await command.overview(periodOf(req.query)))));
router.get('/command/live', safe(async (req, res) => res.json(await command.live({ since: req.query.since }))));
router.get('/command/events', safe(async (req, res) => res.json(await command.drill({
  ...periodOf(req.query), what: String(req.query.what || ''), previous: req.query.previous === '1',
  limit: Number(req.query.limit) || 200,
}))));

/* ------------------------------------------------ business and profitability */

/*
 * The operations module, phase 1 (user, 2026-09-25): Business Health, Today's
 * Summary, Profitability, the transaction ledger and the finance export. The
 * money is src/finance/ledger.js's; the routes check the module's permissions.
 */
const business = require('../admin/business');
const profitability = require('../admin/profitability');
router.get('/business/health', needs('dashboard.view'), safe(async (req, res) => res.json(await business.health(periodOf(req.query)))));
router.get('/business/summary', needs('dashboard.view'), safe(async (_req, res) => res.json(await business.summary())));
router.get('/profitability', needs('finance.view'), safe(async (req, res) => res.json(await profitability.overview({ ...periodOf(req.query), grain: req.query.grain }))));
router.get('/profitability/transactions', needs('finance.view'), safe(async (req, res) => res.json(await profitability.transactions(req.query))));
router.get('/profitability/transactions/:id', needs('finance.view'), safe(async (req, res) => {
  const out = await profitability.transaction(req.params.id);
  if (!out) return res.status(404).json({ error: 'not_found', message: 'No such transaction.' });
  if (!refreshing(req)) {
    await auth.audit({ adminId: req.admin.id, action: 'view_transaction', ip: ipOf(req),
                       detail: { payment_id: String(req.params.id), reg_no: out.ledger.reg_no || null } });
  }
  res.json(out);
}));

/* WhatsApp and vehicle lookups (phase 4): src/admin/whatsappStats.js and
   src/admin/lookups.js, for the same periods as the command center. */
router.get('/whatsapp/stats', safe(async (req, res) => res.json(
  await require('../admin/whatsappStats').stats(periodOf(req.query)))));
router.get('/lookups/summary', safe(async (req, res) => res.json(
  await require('../admin/lookups').summary(periodOf(req.query)))));
router.get('/lookups', safe(async (req, res) => res.json(await require('../admin/lookups').list({
  ...periodOf(req.query), q: req.query.q || '', result: req.query.result || null,
  limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0,
}))));

/* Payments and the records API (phase 5): src/admin/payments.js and
   src/admin/apiMonitor.js. Payments are money, so they need 'money' — the
   same rule as Revenue & GST. */
router.get('/payments/summary', needs('money'), safe(async (req, res) => res.json(
  await require('../admin/payments').summary({ ...periodOf(req.query), grain: req.query.grain }))));
router.get('/payments', needs('money'), safe(async (req, res) => res.json(await require('../admin/payments').list({
  ...periodOf(req.query), status: req.query.status || null, q: req.query.q || '',
  limit: Number(req.query.limit) || 25, offset: Number(req.query.offset) || 0,
}))));
router.get('/payments/:id', needs('money'), safe(async (req, res) => {
  const out = await require('../admin/payments').detail(req.params.id);
  if (!out) return res.status(404).json({ error: 'not_found', message: 'No such payment.' });
  res.json(out);
}));
router.get('/api-monitor', safe(async (req, res) => res.json(
  await require('../admin/apiMonitor').summary(periodOf(req.query)))));
router.get('/api-monitor/log', safe(async (req, res) => res.json(await require('../admin/apiMonitor').log({
  ...periodOf(req.query), dataset: req.query.dataset || '', result: req.query.result || null, q: req.query.q || '',
  limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0,
}))));

/* Health, alerts, pop-ups and menu badges (phase 6): src/admin/health.js and
   src/admin/alerts.js. Acknowledging and resolving are audited. */
const alertCenter = require('../admin/alerts');
router.get('/health/services', safe(async (_req, res) => res.json(await require('../admin/health').services())));
router.get('/alerts', safe(async (req, res) => res.json({ rows: await alertCenter.list({
  status: ['active', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'active',
  severity: req.query.severity || null,
}) })));
router.post('/alerts/:id/ack', safe(async (req, res) => {
  const ok = await alertCenter.ack(req.params.id, req.admin.id);
  if (ok) await auth.audit({ adminId: req.admin.id, action: 'alert_acknowledged', ip: ipOf(req), detail: { alert_id: req.params.id } });
  res.json({ ok });
}));
router.post('/alerts/:id/resolve', safe(async (req, res) => {
  const ok = await alertCenter.resolve(req.params.id, req.admin.id, req.body?.note);
  if (ok) await auth.audit({ adminId: req.admin.id, action: 'alert_resolved', ip: ipOf(req), detail: { alert_id: req.params.id, note: req.body?.note || null } });
  res.json({ ok });
}));
router.get('/feed', safe(async (req, res) => res.json(await alertCenter.feed(req.query.since))));
router.get('/badges', safe(async (_req, res) => res.json(await alertCenter.badges())));

/* Where the vehicles are: by state, then by RTO (phase 7, src/admin/geo.js). */
router.get('/geo/states', safe(async (req, res) => res.json(await require('../admin/geo').states(periodOf(req.query)))));
router.get('/geo/states/:code', safe(async (req, res) => res.json(
  await require('../admin/geo').rtos(req.params.code, periodOf(req.query)))));

/* One person, start to finish, and the CSV exports (phase 3,
   src/admin/journey.js). Both show personal data, so both are audited. */
const journeys = require('../admin/journey');
router.get('/journey', safe(async (req, res) => {
  const out = await journeys.journey({ mobile: req.query.mobile, userId: req.query.user, visitorId: req.query.visitor });
  if (out.found) {
    await auth.audit({ adminId: req.admin.id, action: 'view_journey', ip: ipOf(req),
                       detail: { mobile: out.profile.mobile, user_id: out.profile.user_id } });
  }
  res.json(out);
}));
/* The finance / GST export (operations module): the ledger's own rows and
   figures, with a TOTAL line, so it always matches the transaction table. */
router.get('/export/ledger.csv', needs('finance.export'), safe(async (req, res) => {
  const out = await require('../admin/profitability').exportCsv(periodOf(req.query), { mask: !auth.can(req.admin.role, 'pii') });
  await auth.audit({ adminId: req.admin.id, action: 'export_ledger', ip: ipOf(req),
                     detail: { range: out.range, filter: periodOf(req.query), rows: out.rows } });
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="gaadipe-ledger-' + stamp + '.csv"');
  res.send('﻿' + out.csv);
}));
/* Vehicle records as CSV (the Vehicles module): the explorer's filters and the
   fields chosen, logged with both. Customers' numbers are always masked here. */
router.get('/export/vehicles.csv', needs('vehicles.export'), safe(async (req, res) => {
  const out = await require('../admin/vehicles').exportCsv(req.query, req.admin);
  const filter = Object.fromEntries(Object.entries(req.query).filter(([k, v]) => !['fields', 'ids'].includes(k) && v !== ''));
  await auth.audit({ adminId: req.admin.id, action: 'vehicle_export', ip: ipOf(req),
                     detail: { filter, rows: out.rows, fields: out.fields,
                               selected: req.query.ids ? String(req.query.ids).split(',').length : null,
                               sensitive: 'none (customer numbers masked)' } });
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="gaadipe-vehicles-' + stamp + '.csv"');
  res.send('﻿' + out.csv);   // BOM, so Excel reads ₹ correctly
}));
router.get('/export/:kind', safe(async (req, res) => {
  const kind = String(req.params.kind || '').replace(/\.csv$/, '');
  const out = await journeys.exportCsv(kind, { from: req.query.from, to: req.query.to,
                                               mask: !auth.can(req.admin.role, 'pii') });
  if (!out) return res.status(404).json({ error: 'unknown_export', message: `Exports: ${journeys.EXPORT_KINDS.join(', ')}.` });
  await auth.audit({ adminId: req.admin.id, action: 'export_csv', ip: ipOf(req),
                     detail: { kind, from: req.query.from || null, to: req.query.to || null, rows: out.rows } });
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gaadipe-${kind}-${stamp}.csv"`);
  res.send(`﻿${out.csv}`);   // BOM, so Excel reads ₹ and names correctly
}));

router.get('/dashboard', safe(async (_req, res) => res.json(await stats.dashboard())));

router.get('/series', safe(async (req, res) => res.json(
  await stats.series({ grain: req.query.grain, days: Number(req.query.days) || 30 }))));

router.get('/funnel', safe(async (req, res) => res.json(
  await stats.funnel({ days: Number(req.query.days) || 30 }))));

/*
 * Every sign-in step on the website, newest first (user, 2026-09-18). Search
 * matches a number, IP, device id, model or browser; one device id or IP opens
 * every account it has touched.
 */
router.get('/sign-ins', safe(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const term = q ? `%${q.replace(/[%_]/g, '')}%` : '';
  const { rows } = await db.query(
    `SELECT s.*, u.display_name, u.wa_profile_name, count(*) OVER () AS total_rows
       FROM site_sign_ins s LEFT JOIN users u ON u.id = s.user_id
      WHERE ($1 = '' OR s.event = $1)
        AND ($2 = '' OR s.mobile ILIKE $2 OR s.ip ILIKE $2 OR s.device_id ILIKE $2
             OR s.device_model ILIKE $2 OR s.browser ILIKE $2 OR s.os ILIKE $2 OR s.city ILIKE $2)
        AND ($3 = '' OR s.device_id = $3)
        AND ($4 = '' OR s.ip = $4)
      ORDER BY s.id DESC LIMIT $5 OFFSET $6`,
    [String(req.query.event || ''), term, String(req.query.device_id || ''), String(req.query.ip || ''),
     Math.min(200, Number(req.query.limit) || 25), Number(req.query.offset) || 0]);
  const summary = await db.one(
    `SELECT count(*) FILTER (WHERE event = 'signed_in' AND created_at > now() - interval '1 day')   AS sign_ins_today,
            count(*) FILTER (WHERE event IN ('sign_in_failed', 'code_refused')
                               AND created_at > now() - interval '1 day')                         AS failures_today,
            count(DISTINCT device_id)                                                             AS devices,
            count(DISTINCT ip)                                                                    AS ips,
            (SELECT count(*) FROM site_sessions WHERE ended_at IS NULL)                           AS open_sessions
       FROM site_sign_ins`);
  res.json({
    total: rows[0] ? Number(rows[0].total_rows) : 0,
    summary: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, Number(v)])),
    rows: rows.map(({ total_rows, ...r }) => ({ ...r, id: String(r.id), user_id: r.user_id ? String(r.user_id) : null,
      name: r.display_name || r.wa_profile_name || null, described: device.describe(r),
      // Rows from before the lookup existed are placed now, from their IP.
      place: device.placeOf(r.city || r.region || r.country ? r : device.locate(r.ip)) })),
  });
}));

/*
 * Every website visit (user, 2026-09-18): when it began, how long it lasted,
 * how it ended — signed out, expired, deactivated, or still open — how much was
 * done in it, and from which device and place.
 */
router.get('/sessions', safe(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const term = q ? `%${q.replace(/[%_]/g, '')}%` : '';
  const state = String(req.query.state || '');
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT ${customers.SESSION_COLS}, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
              g.city, g.region, g.country, g.device_model, g.device_vendor, g.device_type,
              g.os, g.os_version, g.browser, g.browser_version,
              count(*) OVER () AS total_rows
         FROM site_sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN site_sign_ins g ON g.id = s.sign_in_id
        WHERE ($1 = '' OR u.mobile ILIKE $1 OR u.display_name ILIKE $1 OR u.wa_profile_name ILIKE $1
               OR s.ip ILIKE $1 OR s.device_id ILIKE $1)
     ) x
     WHERE ($2 = '' OR state = $2)
     ORDER BY id DESC LIMIT $3 OFFSET $4`,
    [term, state, Math.min(200, Number(req.query.limit) || 25), Number(req.query.offset) || 0]);
  const totals = await db.one(
    `SELECT count(*) FILTER (WHERE state = 'online') AS online,
            count(*) FILTER (WHERE created_at > now() - interval '1 day') AS today,
            coalesce(round(avg(seconds)), 0) AS avg_seconds,
            coalesce(sum(seconds), 0) AS total_seconds,
            count(*) AS sessions
       FROM (SELECT ${customers.SESSION_COLS} FROM site_sessions s) x`);
  res.json({
    total: rows[0] ? Number(rows[0].total_rows) : 0,
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number(v)])),
    rows: rows.map(({ total_rows, ...r }) => customers.sessionOut(r)),
  });
}));

/* Period against period, the fleet by class and document state, and when people check. */
const insights = require('../admin/insights');
const device = require('../site/device');
router.get('/insights/compare', safe(async (_req, res) => res.json(await insights.compare())));
router.get('/insights/fleet', safe(async (_req, res) => res.json(await insights.fleet())));
router.get('/insights/heatmap', safe(async (req, res) => res.json(
  await insights.heatmap({ days: Number(req.query.days) || 30 }))));

router.get('/finance', needs('money'), safe(async (req, res) => res.json(
  await stats.finance({ from: req.query.from || null, to: req.query.to || null }))));

/* ------------------------------------------------------------- customers */

router.get('/customers', safe(async (req, res) => {
  const bool = (v) => (v === undefined || v === '' ? null : /^(1|true|yes)$/i.test(String(v)));
  res.json(await customers.list({
    q: req.query.q || '',
    sort: req.query.sort,
    limit: Number(req.query.limit) || 50,
    offset: Number(req.query.offset) || 0,
    blocked: bool(req.query.blocked),
    paying: bool(req.query.paying),
    segment: req.query.segment || null,
  }));
}));

router.get('/customers/:id', safe(async (req, res) => {
  const out = await customers.detail(req.params.id);
  if (!out) return res.status(404).json({ error: 'not_found', message: 'No such customer.' });
  // Reading someone's file is itself an action worth recording.
  if (!refreshing(req)) {
    await auth.audit({ adminId: req.admin.id, action: 'view_customer', ip: ipOf(req),
                       detail: { user_id: req.params.id, mobile: out.user.mobile } });
  }
  res.json(out);
}));

router.post('/customers/:id/pause', needs('block'), safe(async (req, res) => {
  const paused = Boolean(req.body?.paused);
  const row = await customers.setPaused(req.params.id, paused);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'No such customer.' });
  await auth.audit({ adminId: req.admin.id, action: paused ? 'pause_customer' : 'resume_customer',
                     ip: ipOf(req), detail: { user_id: req.params.id } });
  res.json({ ok: true, is_paused: row.is_paused });
}));

/* ------------------------------------------------------------------ live */

router.get('/live/conversations', safe(async (req, res) => res.json({
  rows: await live.conversations({
    limit: Number(req.query.limit) || 60,
    activeMinutes: req.query.active ? Number(req.query.active) : null,
    q: req.query.q || '',
  }),
})));

router.get('/live/thread/:mobile', safe(async (req, res) => {
  const rows = await live.thread(req.params.mobile, { limit: Number(req.query.limit) || 200 });
  if (!refreshing(req)) {
    await auth.audit({ adminId: req.admin.id, action: 'view_thread', ip: ipOf(req),
                       detail: { mobile: req.params.mobile } });
  }
  res.json({ rows });
}));

/* Polled every few seconds — kept out of the audit, or the audit becomes noise. */
router.get('/live/pulse', safe(async (req, res) => res.json(
  await live.pulse({ sinceMessageId: req.query.since || null }))));

router.get('/live/activity', safe(async (req, res) => res.json({
  rows: await live.activity({ limit: Number(req.query.limit) || 50 }),
})));

/* Signed-in visitors on the site, and one visit's trail. Polled, so not audited. */
router.get('/live/visitors', safe(async (req, res) => res.json({
  rows: await live.visitors({ minutes: Number(req.query.minutes) || 30 }),
})));

/* Every customer active in the last N days, and each one's own table of clicks, pages and actions. */
router.get('/live/customers', safe(async (req, res) => res.json({
  rows: await live.customers({ days: Number(req.query.days) || 7, q: req.query.q || '' }),
})));

router.get('/live/customers/:id/activity', safe(async (req, res) => {
  const kinds = ['page', 'click', 'action'];
  const out = await live.customerActivity(String(req.params.id).replace(/\D/g, '') || '0', {
    kind: kinds.includes(req.query.kind) ? req.query.kind : null,
    before: /^\d+$/.test(String(req.query.before || '')) ? req.query.before : null,
    limit: Number(req.query.limit) || 200,
  });
  if (!refreshing(req)) {
    await auth.audit({ adminId: req.admin.id, action: 'view_customer_activity', ip: ipOf(req),
                       detail: { user_id: String(req.params.id) } });
  }
  res.json(out);
}));

router.get('/live/visitors/:id/trail', safe(async (req, res) => res.json({
  rows: await live.trail(req.params.id, { limit: Number(req.query.limit) || 200 }),
})));

/* --------------------------------------------------------------- vehicles */

/*
 * The Vehicles module (user, 2026-09-25): src/admin/vehicles.js reads,
 * src/admin/vehicleOps.js writes. Every route checks its own capability here,
 * on the server — hiding a menu item protects nothing. Reading a vehicle,
 * revealing a number, reading a provider response, refreshing, exporting and
 * every write are audited with the vehicle's number in the detail.
 */
const vehicleDesk = require('../admin/vehicles');
const vehicleOps = require('../admin/vehicleOps');
const vehicleIdsOf = (b) => (Array.isArray(b?.vehicle_ids) ? b.vehicle_ids : []);
const sendOut = (res, out) => res.status(out.ok ? 200 : 400).json(out);

router.get('/vehicles', needs('vehicles.view'), safe(async (req, res) => res.json(await vehicleDesk.list(req.query, req.admin))));
router.get('/vehicles/stats', needs('vehicles.view'), safe(async (_req, res) => res.json(await vehicleDesk.stats())));
router.get('/vehicles/quick', needs('vehicles.view'), safe(async (req, res) => res.json(await vehicleDesk.quick(req.query.q))));
router.get('/vehicles/meta', needs('vehicles.view'), safe(async (_req, res) => res.json({
  ...(await vehicleOps.meta()), export_fields: vehicleDesk.EXPORT_FIELDS, views: Object.keys(vehicleDesk.VIEWS) })));
router.get('/vehicles/intel', needs('vehicles.view'), safe(async (req, res) => res.json(await vehicleOps.intel(req.query))));
router.get('/vehicles/signals', needs('vehicles.view'), safe(async (req, res) => res.json(await vehicleOps.signals(req.query))));
router.get('/vehicles/live', needs('vehicles.view'), safe(async (req, res) => res.json(await vehicleOps.live({ since: req.query.since }))));
router.get('/vehicles/api-logs', needs('vehicles.api_logs'), safe(async (req, res) => res.json(await vehicleOps.apiLogs(req.query))));

// Preferences: the explorer's columns and saved filters, per admin.
router.get('/prefs/:key', safe(async (req, res) => res.json(await vehicleOps.getPref(req.admin, req.params.key))));
router.put('/prefs/:key', safe(async (req, res) => sendOut(res, await vehicleOps.setPref(req.admin, req.params.key, req.body?.value))));

// Saved lists.
router.get('/vehicle-lists', needs('vehicles.view'), safe(async (_req, res) => res.json(await vehicleOps.lists())));
router.post('/vehicle-lists', needs('vehicles.tags'), safe(async (req, res) => sendOut(res,
  await vehicleOps.saveList({ name: req.body?.name, notes: req.body?.notes, admin: req.admin, ip: ipOf(req) }))));
router.put('/vehicle-lists/:id', needs('vehicles.tags'), safe(async (req, res) => sendOut(res,
  await vehicleOps.saveList({ id: req.params.id, name: req.body?.name, notes: req.body?.notes, admin: req.admin, ip: ipOf(req) }))));
router.delete('/vehicle-lists/:id', needs('vehicles.tags'), safe(async (req, res) => sendOut(res,
  await vehicleOps.deleteList({ id: req.params.id, admin: req.admin, ip: ipOf(req) }))));
router.post('/vehicle-lists/:id/items', needs('vehicles.tags'), safe(async (req, res) => sendOut(res,
  await vehicleOps.listItems({ listId: req.params.id, vehicleIds: vehicleIdsOf(req.body), action: req.body?.action,
                               note: req.body?.note, admin: req.admin, ip: ipOf(req) }))));

// Bulk actions over selected vehicles (ids).
router.post('/vehicles/bulk/tags', needs('vehicles.tags'), safe(async (req, res) => sendOut(res,
  await vehicleOps.setTags({ vehicleIds: vehicleIdsOf(req.body), add: req.body?.add, remove: req.body?.remove, admin: req.admin, ip: ipOf(req) }))));
router.post('/vehicles/bulk/assign', needs('vehicles.tags'), safe(async (req, res) => sendOut(res,
  await vehicleOps.assign({ vehicleIds: vehicleIdsOf(req.body), adminId: req.body?.admin_id, admin: req.admin, ip: ipOf(req) }))));
router.post('/vehicles/bulk/archive', needs('vehicles.tags'), safe(async (req, res) => sendOut(res,
  await vehicleOps.archive({ vehicleIds: vehicleIdsOf(req.body), archived: req.body?.archived !== false, admin: req.admin, ip: ipOf(req) }))));

// Notes: added, edited (the old text kept), withdrawn — never deleted.
router.post('/vehicles/:reg/notes', needs('vehicles.notes'), safe(async (req, res) => sendOut(res,
  await vehicleOps.addNote({ reg: req.params.reg, body: req.body?.body, admin: req.admin, ip: ipOf(req) }))));
router.put('/vehicle-notes/:id', needs('vehicles.notes'), safe(async (req, res) => sendOut(res,
  await vehicleOps.editNote({ noteId: req.params.id, body: req.body?.body, admin: req.admin, ip: ipOf(req) }))));
router.delete('/vehicle-notes/:id', needs('vehicles.notes'), safe(async (req, res) => sendOut(res,
  await vehicleOps.withdrawNote({ noteId: req.params.id, admin: req.admin, ip: ipOf(req) }))));
router.get('/vehicle-notes/:id/versions', needs('vehicles.view'), safe(async (req, res) => res.json(await vehicleOps.noteVersions(req.params.id))));

// One vehicle, whole.
router.get('/vehicles/:reg', needs('vehicles.view'), safe(async (req, res) => {
  const out = await vehicleDesk.profile(req.params.reg, {
    admin: req.admin, canSensitive: auth.can(req.admin.role, 'vehicles.view_sensitive'),
    canApi: auth.can(req.admin.role, 'vehicles.api_logs') });
  if (!out) return res.status(404).json({ error: 'not_found', message: 'GaadiPe has not seen this vehicle.' });
  if (!refreshing(req)) {
    await auth.audit({ adminId: req.admin.id, action: 'view_vehicle', ip: ipOf(req),
                       detail: { reg_no: out.vehicle.reg_no, vehicle_id: out.vehicle.id, result: 'ok' } });
  }
  res.json(out);
}));

router.post('/vehicles/:reg/reveal', needs('vehicles.view_sensitive'), safe(async (req, res) => {
  const what = req.body?.what === 'owner' ? 'owner' : 'customer';
  const out = await vehicleDesk.reveal(req.params.reg, { ref: req.body?.ref, what });
  if (!out) return res.status(404).json({ error: 'not_found', message: 'No such vehicle.' });
  const found = what === 'owner' ? Boolean(out.owner_name || out.address) : Boolean(out.mobile);
  await auth.audit({ adminId: req.admin.id, action: what === 'owner' ? 'reveal_rc_owner' : 'reveal_phone', ip: ipOf(req),
                     detail: { reg_no: out.vehicle.reg_no, vehicle_id: String(out.vehicle.id), ref: req.body?.ref || null,
                               user_id: out.user_id || null, result: found ? 'shown' : 'not_found' } });
  if (!found) return res.status(404).json({ error: 'not_found', message: 'Nothing to reveal for that.' });
  res.json(what === 'owner' ? { owner_name: out.owner_name, address: out.address } : { mobile: out.mobile, user_id: out.user_id });
}));

router.get('/vehicles/:reg/raw/:dataset', needs('vehicles.api_logs'), safe(async (req, res) => {
  const out = await vehicleDesk.rawResponse(req.params.reg, req.params.dataset,
    { canSensitive: auth.can(req.admin.role, 'vehicles.view_sensitive') });
  if (!out) return res.status(404).json({ error: 'not_found', message: 'No such vehicle or dataset.' });
  await auth.audit({ adminId: req.admin.id, action: 'view_api_response', ip: ipOf(req),
                     detail: { reg_no: out.vehicle.reg_no, vehicle_id: String(out.vehicle.id), dataset: req.params.dataset,
                               result: out.found ? 'shown' : 'none_stored' } });
  const { vehicle: _vehicle, ...rest } = out;
  res.json(rest);
}));

router.post('/vehicles/:reg/tags', needs('vehicles.tags'), safe(async (req, res) => {
  const v = await vehicleDesk.find(req.params.reg);
  if (!v) return res.status(404).json({ error: 'not_found', message: 'No such vehicle.' });
  sendOut(res, await vehicleOps.setTags({ vehicleIds: [v.id], add: req.body?.add, remove: req.body?.remove, admin: req.admin, ip: ipOf(req) }));
}));

/*
 * A fresh records-API lookup. It may cost money, so the panel shows the cost
 * first and sends confirm; a vehicle looked up in the last ten minutes also
 * needs force, so a double click never spends twice.
 */
router.post('/vehicles/:reg/refresh', needs('vehicles.refresh'), safe(async (req, res) => {
  const v = await vehicleDesk.find(req.params.reg);
  if (!v) return res.status(404).json({ error: 'not_found', message: 'No such vehicle.' });
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm', message: 'Confirm the refresh first.' });
  const last = await db.one('SELECT created_at FROM api_calls WHERE reg_no = $1 AND NOT cache_hit ORDER BY id DESC LIMIT 1', [v.reg_no]);
  const mins = last ? (Date.now() - new Date(last.created_at)) / 60000 : null;
  if (mins != null && mins < 10 && req.body?.force !== true) {
    return res.status(409).json({ error: 'recent', minutes: Math.floor(mins),
      message: 'This vehicle was looked up ' + Math.floor(mins) + ' minute(s) ago. Refresh again anyway?' });
  }
  let result = 'ok';
  try {
    await gateway.full(v.reg_no, { refresh: 1 });
  } catch (e) {
    result = 'failed: ' + String(e.message || e).slice(0, 120);
  }
  await auth.audit({ adminId: req.admin.id, action: 'vehicle_refresh', ip: ipOf(req),
                     detail: { reg_no: v.reg_no, vehicle_id: String(v.id), forced: req.body?.force === true, result } });
  if (result !== 'ok') return res.status(502).json({ error: 'refresh_failed', message: 'The records API did not answer. Nothing was changed.' });
  res.json({ ok: true });
}));

/**
 * Look a vehicle up for yourself — the panel's own check.
 *
 * Goes through the same gateway the bot uses, so what the panel shows is what a
 * customer would be shown. `refresh=1` spends a fresh ULIP call, which is free
 * today and the reason this screen exists at all.
 */
router.get('/check/:regNo', needs('lookup'), safe(async (req, res) => {
  const parsed = plate.parse(req.params.regNo);
  if (!parsed.ok) {
    return res.status(400).json({ error: 'bad_plate', message: parsed.error });
  }
  const data = await gateway.full(parsed.regNo, {
    refresh: req.query.refresh === '1' ? 1 : undefined,
    challans: req.query.challans === 'all' ? 'all' : undefined,
  });
  await auth.audit({ adminId: req.admin.id, action: 'admin_check', ip: ipOf(req),
                     detail: { reg_no: parsed.regNo, refresh: req.query.refresh === '1' } });
  res.json(data);
}));

/* ---------------------------------------------------------------- blocks */

router.get('/blocks', safe(async (req, res) => res.json({
  rows: await blocks.list({
    kind: req.query.kind || null,
    includeReleased: req.query.history === '1',
  }),
})));

router.post('/blocks', needs('block'), safe(async (req, res) => {
  const { kind, value, reason } = req.body || {};
  if (!['mobile', 'vehicle'].includes(kind)) {
    return res.status(400).json({ error: 'bad_kind', message: 'Block a mobile number or a vehicle.' });
  }
  const out = await blocks.block({ kind, value, reason, adminId: req.admin.id, ip: ipOf(req) });
  if (!out.ok) return res.status(400).json({ error: 'bad_value', message: out.message });
  res.json(out);
}));

router.post('/blocks/:id/release', needs('block'), safe(async (req, res) => {
  const out = await blocks.release({ id: req.params.id, adminId: req.admin.id, ip: ipOf(req) });
  if (!out.ok) return res.status(400).json({ error: 'not_blocked', message: out.message });
  res.json(out);
}));

/* ----------------------------------------------------- reports & invoices */

router.get('/reports', safe(async (req, res) => {
  const term = String(req.query.q || '').trim();
  const { rows } = await db.query(
    `SELECT r.id, r.report_number, r.reg_no, r.created_at, r.valid_until, r.pdf_path,
            r.channel, r.device, r.ip, r.requester_name, r.requested_by,
            u.id AS user_id, u.mobile, count(*) OVER () AS total_rows
       FROM vehicle_reports r LEFT JOIN users u ON u.id = r.user_id
      WHERE ($1 = '' OR r.report_number ILIKE '%' || $1 || '%'
             OR r.reg_no ILIKE '%' || $1 || '%' OR r.requested_by LIKE '%' || $1 || '%')
      ORDER BY r.id DESC LIMIT $2 OFFSET $3`,
    [term, Math.min(200, Number(req.query.limit) || 50), Number(req.query.offset) || 0]);
  res.json({
    total: rows[0] ? Number(rows[0].total_rows) : 0,
    rows: rows.map(({ total_rows, pdf_path, ...r }) => ({
      ...r, id: String(r.id), user_id: r.user_id ? String(r.user_id) : null,
      has_pdf: Boolean(pdf_path) })),
  });
}));

router.get('/invoices', needs('money'), safe(async (req, res) => {
  const term = String(req.query.q || '').trim();
  const { rows } = await db.query(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.base_paise, i.total_paise,
            i.cgst_paise, i.sgst_paise, i.igst_paise, i.place_of_supply, i.buyer_name,
            i.pdf_path, u.id AS user_id, u.mobile, v.reg_no,
            count(*) OVER () AS total_rows
       FROM invoices i
       LEFT JOIN users u ON u.id = i.user_id
       LEFT JOIN subscriptions s ON s.id = i.subscription_id
       LEFT JOIN vehicles v ON v.id = s.vehicle_id
      WHERE ($1 = '' OR i.invoice_number ILIKE '%' || $1 || '%'
             OR u.mobile LIKE '%' || $1 || '%' OR i.buyer_name ILIKE '%' || $1 || '%')
      ORDER BY i.id DESC LIMIT $2 OFFSET $3`,
    [term, Math.min(200, Number(req.query.limit) || 50), Number(req.query.offset) || 0]);
  res.json({
    total: rows[0] ? Number(rows[0].total_rows) : 0,
    rows: rows.map(({ total_rows, pdf_path, ...r }) => ({
      ...r, id: String(r.id), user_id: r.user_id ? String(r.user_id) : null,
      has_pdf: Boolean(pdf_path) })),
  });
}));

/**
 * The PDF itself.
 *
 * Fetched with the session token rather than opened as a plain link — a link
 * cannot carry an Authorization header, and a token in a URL ends up in browser
 * history and server logs. `?download=1` asks the browser to save rather than
 * display; the panel prints from the displayed copy.
 */
const sendPdf = (table, column) => safe(async (req, res) => {
  const row = await db.one(
    `SELECT ${column} AS number, pdf_path FROM ${table} WHERE id = $1`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'No such document.' });
  /* A missing file is rebuilt from its row, so View and Download always work
     (pay/rebuild.js). */
  row.pdf_path = await require('../pay/rebuild').ensureFile(table, req.params.id);
  await auth.audit({ adminId: req.admin.id, action: `download_${table}`, ip: ipOf(req),
                     detail: { number: row.number } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${row.number}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(row.pdf_path).pipe(res);
});

router.get('/reports/:id/file', sendPdf('vehicle_reports', 'report_number'));
router.get('/invoices/:id/file', needs('money'), sendPdf('invoices', 'invoice_number'));

/* -------------------------------------------------------------- settings */

router.get('/settings', safe(async (_req, res) => {
  const { rows } = await db.query(`SELECT key, value, modified_at FROM app_settings ORDER BY key`);
  const plans = await db.query(`SELECT * FROM plans ORDER BY sort_order, id`);
  res.json({ settings: rows, plans: plans.rows.map(p => ({ ...p, id: String(p.id) })) });
}));

router.put('/settings', needs('settings'), safe(async (req, res) => {
  const changes = req.body?.settings || {};
  const keys = Object.keys(changes);
  if (!keys.length) return res.json({ ok: true, changed: 0 });

  const before = await db.query(
    `SELECT key, value FROM app_settings WHERE key = ANY($1)`, [keys]);
  const was = Object.fromEntries(before.rows.map(r => [r.key, r.value]));

  // Only keys that already exist may be written: a typo would otherwise create
  // a setting nothing reads, which looks like a change that did nothing.
  const unknown = keys.filter(k => !(k in was));
  if (unknown.length) {
    return res.status(400).json({ error: 'unknown_setting',
      message: `Not a setting: ${unknown.join(', ')}` });
  }

  for (const key of keys) {
    await db.query(
      `UPDATE app_settings SET value = $2, modified_at = now() WHERE key = $1`,
      [key, String(changes[key])]);
  }
  settings.refresh();
  await auth.audit({ adminId: req.admin.id, action: 'settings_changed', ip: ipOf(req),
                     detail: { changes, was } });
  res.json({ ok: true, changed: keys.length });
}));

router.put('/plans/:code', needs('settings'), safe(async (req, res) => {
  const { name, price_paise, renewal_paise, duration_days, is_active } = req.body || {};
  const before = await db.one(`SELECT * FROM plans WHERE code = $1`, [req.params.code]);
  if (!before) return res.status(404).json({ error: 'not_found', message: 'No such plan.' });

  const { rows } = await db.query(
    `UPDATE plans SET
       name = coalesce($2, name),
       price_paise = coalesce($3, price_paise),
       renewal_paise = coalesce($4, renewal_paise),
       duration_days = coalesce($5, duration_days),
       is_active = coalesce($6, is_active)
     WHERE code = $1 RETURNING *`,
    [req.params.code, name ?? null,
     price_paise ?? null, renewal_paise ?? null, duration_days ?? null,
     is_active === undefined ? null : Boolean(is_active)]);

  await auth.audit({ adminId: req.admin.id, action: 'plan_changed', ip: ipOf(req),
                     detail: { code: req.params.code, before, after: rows[0] } });
  res.json({ ok: true, plan: { ...rows[0], id: String(rows[0].id) } });
}));

/* -------------------------------------------------------------- policies */

/* slug -> table, exactly as the public endpoint serves them. */
const POLICIES = {
  terms: 'terms_and_conditions',
  privacy: 'privacy_policy',
  refund: 'refund_policy',
  liability: 'liability_policy',
  consent: 'consent_policy',
  cancellation: 'cancellation_policy',
  delivery: 'delivery_policy',
  'data-deletion': 'data_deletion_policy',
  partner: 'partner_policy',
};

router.get('/policies/:slug', safe(async (req, res) => {
  const table = POLICIES[req.params.slug];
  if (!table) return res.status(404).json({ error: 'not_found', message: 'No such policy.' });
  const { rows } = await db.query(
    `SELECT id, title, description, display_order, version, effective_from, is_active
       FROM ${table} ORDER BY display_order, id`);
  res.json({ slug: req.params.slug, rows: rows.map(r => ({ ...r, id: String(r.id) })) });
}));

router.put('/policies/:slug/:id', needs('settings'), safe(async (req, res) => {
  const table = POLICIES[req.params.slug];
  if (!table) return res.status(404).json({ error: 'not_found', message: 'No such policy.' });
  const { title, description, display_order, version, effective_from, is_active } = req.body || {};

  const before = await db.one(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
  if (!before) return res.status(404).json({ error: 'not_found', message: 'No such clause.' });

  const { rows } = await db.query(
    `UPDATE ${table} SET
       title = coalesce($2, title),
       description = coalesce($3, description),
       display_order = coalesce($4, display_order),
       version = coalesce($5, version),
       effective_from = coalesce($6, effective_from),
       is_active = coalesce($7, is_active),
       modified_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id, title ?? null, description ?? null, display_order ?? null,
     version ?? null, effective_from ?? null,
     is_active === undefined ? null : Boolean(is_active)]);

  // The public site caches policy text for ten minutes; an edit nobody can see
  // looks like an edit that failed.
  require('./public').refresh?.();

  await auth.audit({ adminId: req.admin.id, action: 'policy_changed', ip: ipOf(req),
                     detail: { slug: req.params.slug, id: req.params.id,
                               before: { title: before.title, description: before.description,
                                         version: before.version } } });
  res.json({ ok: true, clause: { ...rows[0], id: String(rows[0].id) } });
}));

router.post('/policies/:slug', needs('settings'), safe(async (req, res) => {
  const table = POLICIES[req.params.slug];
  if (!table) return res.status(404).json({ error: 'not_found', message: 'No such policy.' });
  const { title, description, display_order, version } = req.body || {};
  if (!title || !description) {
    return res.status(400).json({ error: 'incomplete', message: 'A clause needs a title and text.' });
  }
  const { rows } = await db.query(
    `INSERT INTO ${table} (title, description, display_order, version, effective_from, is_active)
          VALUES ($1,$2,coalesce($3, 999),coalesce($4,'1.0'),CURRENT_DATE,true) RETURNING *`,
    [title, description, display_order ?? null, version ?? null]);
  require('./public').refresh?.();
  await auth.audit({ adminId: req.admin.id, action: 'policy_added', ip: ipOf(req),
                     detail: { slug: req.params.slug, title } });
  res.json({ ok: true, clause: { ...rows[0], id: String(rows[0].id) } });
}));

/* --------------------------------------------------------------- feedback */

router.get('/feedback', safe(async (req, res) => {
  const { rows } = await db.query(
    `SELECT f.id, f.mobile, f.reg_no, f.body, f.created_at,
            u.id AS user_id, u.wa_profile_name AS name, count(*) OVER () AS total_rows
       FROM feedback f LEFT JOIN users u ON u.id = f.user_id
      ORDER BY f.id DESC LIMIT $1 OFFSET $2`,
    [Math.min(200, Number(req.query.limit) || 100), Number(req.query.offset) || 0]);
  res.json({ total: rows[0] ? Number(rows[0].total_rows) : 0,
             rows: rows.map(({ total_rows, ...r }) => ({ ...r, id: String(r.id),
                                    user_id: r.user_id ? String(r.user_id) : null })) });
}));

/* -------------------------------------------------------------- security */

/* Everything the guard refused or slowed down (user, 2026-09-18). */
router.get('/security-events', safe(async (req, res) => {
  const { rows } = await db.query(
    `SELECT e.*, count(*) OVER () AS total_rows FROM security_events e
      WHERE ($1 = '' OR e.kind = $1) AND ($2 = '' OR e.ip = $2)
      ORDER BY e.id DESC LIMIT $3 OFFSET $4`,
    [String(req.query.kind || ''), String(req.query.ip || ''),
     Math.min(200, Number(req.query.limit) || 25), Number(req.query.offset) || 0]);
  const summary = await db.one(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today,
            count(*) FILTER (WHERE created_at > now() - interval '1 day' AND severity = 'high')::int AS serious_today,
            count(DISTINCT ip) FILTER (WHERE created_at > now() - interval '1 day')::int AS ips_today,
            count(*)::int AS total
       FROM security_events`);
  const device = require('../site/device');
  res.json({ total: rows[0] ? Number(rows[0].total_rows) : 0, summary,
             rows: rows.map(({ total_rows, ...r }) => ({ ...r, id: String(r.id), user_id: r.user_id ? String(r.user_id) : null,
               place: device.placeOf(device.locate(r.ip)), described: device.describe(device.parseUA(r.user_agent)) })) });
}));

/* ------------------------------------------------------ contact messages */

/* What the website's "Contact us" form sent (user, 2026-09-18). */
router.get('/contact-messages', safe(async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.*, count(*) OVER () AS total_rows,
            (SELECT n.status FROM admin_notifications n WHERE n.kind = 'contact' AND n.ref = c.id::text) AS emailed
       FROM contact_messages c
      WHERE ($1 = '' OR c.status = $1)
      ORDER BY c.id DESC LIMIT $2 OFFSET $3`,
    [String(req.query.status || ''), Math.min(200, Number(req.query.limit) || 25), Number(req.query.offset) || 0]);
  res.json({ total: rows[0] ? Number(rows[0].total_rows) : 0,
             rows: rows.map(({ total_rows, ...r }) => ({ ...r, id: String(r.id), user_id: r.user_id ? String(r.user_id) : null })) });
}));

router.put('/contact-messages/:id', safe(async (req, res) => {
  const status = String(req.body?.status || '');
  if (!['new', 'replied', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'bad_status', message: 'Status must be new, replied or closed.' });
  }
  await db.query(`UPDATE contact_messages SET status = $2 WHERE id = $1`, [req.params.id, status]);
  await auth.audit({ adminId: req.admin.id, action: 'contact_status', ip: ipOf(req), detail: { id: req.params.id, status } });
  res.json({ ok: true });
}));

/* The admin emails: what went, what failed and why (user, 2026-09-18). */
router.get('/notifications', safe(async (req, res) => {
  const { rows } = await db.query(
    `SELECT *, count(*) OVER () AS total_rows FROM admin_notifications ORDER BY id DESC LIMIT $1 OFFSET $2`,
    [Math.min(200, Number(req.query.limit) || 25), Number(req.query.offset) || 0]);
  res.json({ total: rows[0] ? Number(rows[0].total_rows) : 0,
             mail_configured: require('../mail/mailer').configured(),
             recipients: await require('../mail/mailer').adminRecipients(),
             rows: rows.map(({ total_rows, ...r }) => ({ ...r, id: String(r.id) })) });
}));

/* ------------------------------------------------------ people and record */

router.get('/admins', needs('admins'), safe(async (_req, res) =>
  res.json({ rows: await auth.listAdmins() })));

router.post('/admins', needs('admins'), safe(async (req, res) => {
  const { mobile, name, role } = req.body || {};
  if (!name) return res.status(400).json({ error: 'incomplete', message: 'A name is required.' });
  try {
    const user = await auth.addAdmin({ mobile, name, role });
    await auth.audit({ adminId: req.admin.id, action: 'admin_added', ip: ipOf(req), detail: { mobile, role } });
    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({ error: 'bad_request', message: e.message });
  }
}));

router.post('/admins/:id/active', needs('admins'), safe(async (req, res) => {
  const user = await auth.setAdminActive(req.params.id, Boolean(req.body?.active));
  if (!user) return res.status(404).json({ error: 'not_found', message: 'No such admin.' });
  await auth.audit({ adminId: req.admin.id, action: 'admin_active_changed', ip: ipOf(req),
                     detail: { id: req.params.id, active: Boolean(req.body?.active) } });
  res.json({ ok: true, user });
}));

router.get('/audit', safe(async (req, res) => {
  const { rows } = await db.query(
    `SELECT a.id, a.action, a.detail, a.ip, a.created_at, u.name, u.mobile,
            count(*) OVER () AS total_rows
       FROM admin_audit a LEFT JOIN admin_users u ON u.id = a.admin_id
      WHERE ($1 = '' OR a.action = $1)
      ORDER BY a.id DESC LIMIT $2 OFFSET $3`,
    [String(req.query.action || ''), Math.min(200, Number(req.query.limit) || 100),
     Number(req.query.offset) || 0]);
  res.json({ total: rows[0] ? Number(rows[0].total_rows) : 0,
             rows: rows.map(({ total_rows, ...r }) => ({ ...r, id: String(r.id) })) });
}));

/* ------------------------------------------------------------ maintenance */

const maintenance = require('../admin/maintenance');

router.get('/maintenance/preview', needs('admins'), safe(async (_req, res) =>
  res.json(await maintenance.preview())));

/**
 * Clear customer and test data. Owner only, and the word CLEAN must be typed:
 * a button alone is one careless click away from an empty database.
 */
router.post('/maintenance/clean', needs('admins'), safe(async (req, res) => {
  if (req.body?.confirm !== 'CLEAN') {
    return res.status(400).json({ error: 'not_confirmed', message: 'Type CLEAN to confirm.' });
  }
  const out = await maintenance.clean({ adminId: req.admin.id, ip: ipOf(req) });
  if (!out.ok) return res.status(403).json({ error: 'not_allowed', message: out.message });
  res.json(out);
}));

/**
 * The whole database as a pg_dump file. Owner only, DOWNLOAD typed, one every
 * ten minutes, recorded in the audit trail (admin/backup.js). A file, so it
 * travels outside the encrypted envelope like the PDFs (app.js).
 */
router.get('/maintenance/backup', needs('admins'), safe(async (req, res) => {
  if (req.query.confirm !== 'DOWNLOAD') {
    return res.status(400).json({ error: 'not_confirmed', message: 'Type DOWNLOAD to confirm.' });
  }
  const backup = require('../admin/backup');
  const wait = backup.waitMinutes(req.admin.id);
  if (wait) {
    return res.status(429).json({ error: 'too_soon',
      message: `A backup was downloaded a moment ago. Try again in ${wait} minute${wait === 1 ? '' : 's'}.` });
  }
  await backup.stream(res, { adminId: req.admin.id, ip: ipOf(req) });
}));

/* ----------------------------------------------------------------- health */

/** Is anything quietly broken? The panel shows this as a strip of lights. */
router.get('/health', safe(async (_req, res) => {
  const row = await db.one(
    `SELECT
       (SELECT count(*) FROM payments
         WHERE status = 'created' AND created_at < now() - interval '10 minutes'
           AND created_at > now() - interval '48 hours')                  AS payments_stuck,
       (SELECT count(*) FROM whatsapp_messages
         WHERE direction = 'out' AND error_message IS NOT NULL
           AND created_at > now() - interval '24 hours')                  AS send_failures,
       (SELECT count(*) FROM api_calls
         WHERE NOT ok AND created_at > now() - interval '24 hours')       AS lookup_failures,
       (SELECT count(*) FROM watches
         WHERE is_active AND fail_count > 2)                              AS watches_failing,
       (SELECT count(*) FROM payments p
         WHERE p.status = 'paid'
           AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.payment_id = p.id)) AS invoices_missing,
       (SELECT count(*) FROM payments p
         JOIN plans pl ON pl.id = p.plan_id
         WHERE p.status = 'paid' AND pl.kind = 'report'
           AND NOT EXISTS (SELECT 1 FROM vehicle_reports r WHERE r.payment_id = p.id)) AS reports_missing`);
  res.json({
    payments_stuck: Number(row.payments_stuck),
    send_failures: Number(row.send_failures),
    lookup_failures: Number(row.lookup_failures),
    watches_failing: Number(row.watches_failing),
    invoices_missing: Number(row.invoices_missing),
    reports_missing: Number(row.reports_missing),
    at: new Date().toISOString(),
  });
}));

/* ───────────────────── GaadiPe's own referrals (user, 2026-09-23) ── */

/*
 * Refer a friend who also has a vehicle. Shown alongside the QuizPe history
 * rather than replacing it: QuizPe is switched off, not deleted, and anyone
 * still holding a credit from it has to remain answerable for.
 */
router.get('/gp-referrals', safe(async (req, res) => {
  const status = ['tapped', 'signed_up', 'rewarded', 'expired', 'not_eligible'].includes(req.query.status)
    ? req.query.status : null;
  const { rows } = await db.query(
    `SELECT r.id, r.code, r.mobile_masked, r.status, r.status_reason, r.device_id,
            r.signed_up_at, r.rewarded_at, r.expires_at, r.created_at, r.payment_id,
            u.id AS referrer_id, u.mobile AS referrer_mobile,
            coalesce(u.display_name, u.wa_profile_name) AS referrer_name,
            f.mobile AS referred_mobile,
            c.id AS credit_id, c.used_at, c.used_reg_no, c.revoked_at, c.revoked_reason,
            c.expires_at AS credit_expires_at,
            p.amount_paise
       FROM gaadipe_referrals r
       JOIN users u ON u.id = r.referrer_id
       LEFT JOIN users f ON f.id = r.referred_user_id
       LEFT JOIN report_credits c ON c.gaadipe_referral_id = r.id
       LEFT JOIN payments p ON p.id = r.payment_id
      WHERE ($1::text IS NULL OR r.status = $1)
      ORDER BY r.id DESC LIMIT 300`, [status]);
  const totals = await db.one(
    `SELECT count(*)::int AS referrals,
            count(*) FILTER (WHERE status = 'signed_up')::int AS waiting,
            count(*) FILTER (WHERE status = 'rewarded')::int AS rewarded,
            count(*) FILTER (WHERE status = 'expired')::int AS expired,
            count(*) FILTER (WHERE status = 'not_eligible')::int AS not_eligible,
            count(DISTINCT referrer_id)::int AS referrers,
            (SELECT count(*) FROM report_credits
              WHERE source = 'gaadipe_referral' AND used_at IS NOT NULL)::int AS credits_used,
            (SELECT count(*) FROM report_credits
              WHERE source = 'gaadipe_referral' AND used_at IS NULL AND revoked_at IS NULL
                AND expires_at > now())::int AS credits_waiting,
            coalesce((SELECT sum(p.amount_paise) FROM gaadipe_referrals r2
                       JOIN payments p ON p.id = r2.payment_id
                      WHERE r2.status = 'rewarded'), 0)::int AS revenue_paise
       FROM gaadipe_referrals`);
  res.json({
    rows: rows.map((r) => ({ ...r, id: String(r.id), referrer_id: String(r.referrer_id),
      // The referred person's number is masked here too: the panel shows who
      // was brought in, not a list of numbers to contact.
      referred_mobile: undefined,
      credit_id: r.credit_id ? String(r.credit_id) : null })),
    totals,
    enabled: String(await settings.get('gaadipe_referral_enabled', 'true')).toLowerCase() !== 'false',
    monthly_cap: await settings.num('gaadipe_referral_monthly_cap', 10),
    window_days: await settings.num('gaadipe_referral_window_days', 30),
    credit_valid_days: await settings.num('referral_credit_valid_days', 90),
  });
}));

/* ─────────────────────────────── QuizPe referrals (user, 2026-09-21) ── */

router.get('/referrals', safe(async (req, res) => {
  const status = ['pending', 'rewarded', 'expired', 'not_eligible', 'revoked'].includes(req.query.status) ? req.query.status : null;
  const { rows } = await db.query(
    `SELECT r.id, r.parent_name, r.mobile_masked, r.status, r.status_reason, r.quizpe_payment, r.quizpe_amount,
            r.rewarded_at, r.expires_at, r.created_at, r.last_checked_at, r.code, r.tapped_at,
            u.id AS referrer_id, u.mobile AS referrer_mobile, coalesce(u.display_name, u.wa_profile_name) AS referrer_name,
            c.id AS credit_id, c.used_at, c.used_reg_no, c.revoked_at, c.expires_at AS credit_expires_at
       FROM quizpe_referrals r
       JOIN users u ON u.id = r.referrer_id
       LEFT JOIN report_credits c ON c.referral_id = r.id
      WHERE ($1::text IS NULL OR r.status = $1)
      ORDER BY r.id DESC LIMIT 300`, [status]);
  const totals = await db.one(
    `SELECT count(*)::int AS referrals,
            count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status = 'rewarded')::int AS rewarded,
            count(*) FILTER (WHERE status = 'expired')::int AS expired,
            count(*) FILTER (WHERE status = 'not_eligible')::int AS not_eligible,
            count(DISTINCT referrer_id)::int AS referrers,
            (SELECT count(*) FROM report_credits WHERE source = 'referral' AND used_at IS NOT NULL)::int AS credits_used,
            coalesce((SELECT sum(quizpe_amount) FROM quizpe_referrals WHERE status = 'rewarded'), 0)::numeric AS quizpe_revenue
       FROM quizpe_referrals`);
  res.json({ rows: rows.map((r) => ({ ...r, id: String(r.id), referrer_id: String(r.referrer_id),
                                       credit_id: r.credit_id ? String(r.credit_id) : null })),
             totals, quizpe_connected: require('../quizpe/readonly').configured() });
}));

/* Every referral link: whose, how often opened, what it brought. */
router.get('/referral-links', safe(async (req, res) => {
  const { rows } = await db.query(
    `SELECT l.user_id, l.code, l.is_active, l.disabled_reason, l.created_at, l.reset_at,
            u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.quizpe_consent_at,
            (SELECT count(*) FROM referral_clicks c WHERE c.link_id = l.id AND c.outcome = 'opened')::int AS opened,
            (SELECT count(*) FROM quizpe_referrals r WHERE r.link_id = l.id)::int AS taps,
            (SELECT count(*) FROM quizpe_referrals r WHERE r.link_id = l.id AND r.status = 'rewarded')::int AS rewarded
       FROM referral_links l JOIN users u ON u.id = l.user_id
      ORDER BY rewarded DESC, taps DESC, l.id DESC LIMIT 300`);
  res.json({ rows: rows.map((r) => ({ ...r, user_id: String(r.user_id) })) });
}));

/* Reset a link (the old one stops working) or switch it off / on. Audited. */
router.post('/referral-links/:userId/:action', needs('settings'), safe(async (req, res) => {
  const referrals = require('../referrals/quizpe');
  const userId = String(req.params.userId).replace(/\D/g, '');
  const reason = String(req.body?.reason || '').trim().slice(0, 300) || null;
  let row;
  if (req.params.action === 'reset') row = await referrals.resetLink(userId);
  else if (req.params.action === 'disable') row = await referrals.setLinkActive(userId, false, reason || 'disabled by admin');
  else if (req.params.action === 'enable') row = await referrals.setLinkActive(userId, true);
  else return res.status(400).json({ error: 'action', message: 'Unknown action.' });
  if (!row) return res.status(404).json({ error: 'not_found', message: 'That customer has no referral link.' });
  await auth.audit({ adminId: req.admin.id, action: `referral_link_${req.params.action}`, ip: ipOf(req),
    detail: { user_id: userId, code: row.code, reason } });
  res.json({ ok: true, code: row.code, is_active: row.is_active });
}));

/* Take back an unused free report (abuse). */
router.post('/referrals/credits/:id/revoke', needs('settings'), safe(async (req, res) => {
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (reason.length < 3) return res.status(400).json({ error: 'reason', message: 'Please give a reason.' });
  const { rows } = await db.query(
    `UPDATE report_credits SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id, user_id, referral_id`, [req.params.id, reason]);
  if (!rows.length) return res.status(409).json({ error: 'not_revocable', message: 'That free report is already used or revoked.' });
  if (rows[0].referral_id) await db.query(`UPDATE quizpe_referrals SET status = 'revoked', status_reason = $2 WHERE id = $1`, [rows[0].referral_id, reason]);
  await auth.audit({ adminId: req.admin.id, action: 'revoke_referral_credit', ip: ipOf(req),
    detail: { credit_id: String(rows[0].id), user_id: String(rows[0].user_id), reason } });
  res.json({ ok: true });
}));

/* Customers who agreed that QuizPe may message them (consent in force now). */
router.get('/quizpe-consents', safe(async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.quizpe_consent_at, u.quizpe_consent_text
       FROM users u
      WHERE u.quizpe_consent_at IS NOT NULL AND u.deactivated_at IS NULL
      ORDER BY u.quizpe_consent_at DESC`);
  if (!refreshing(req)) {
    await auth.audit({ adminId: req.admin.id, action: 'view_quizpe_consents', ip: ipOf(req), detail: { count: rows.length } });
  }
  res.json({ rows: rows.map((r) => ({ ...r, id: String(r.id) })) });
}));

/* ─────────────────────────── emails to customers (admin, 2026-09-21) ── */

const customerEmails = require('../admin/customerEmails');

/* Every customer email (daily, digest, confirm, reward, announcement), plus reach. */
router.get('/customer-emails', safe(async (req, res) => {
  const kinds = ['confirm', 'daily', 'digest', 'reward', 'announcement'];
  const statuses = ['pending', 'sent', 'failed', 'skipped'];
  res.json({
    ...(await customerEmails.log({
      kind: kinds.includes(req.query.kind) ? req.query.kind : null,
      status: statuses.includes(req.query.status) ? req.query.status : null,
      q: req.query.q || '' })),
    campaigns: await customerEmails.campaigns(),
    audiences: customerEmails.AUDIENCES,
  });
}));

router.post('/customer-emails/preview', needs('settings'), safe(async (req, res) => res.json(
  await customerEmails.preview(req.body || {}))));

router.post('/customer-emails/test', needs('settings'), safe(async (req, res) => {
  const out = await customerEmails.testSend(req.body || {}, req.admin);
  if (!out.ok) return res.status(502).json(out);
  res.json(out);
}));

/* Send: typed confirmation, audited. Queued, then sent a few a minute. */
router.post('/customer-emails/send', needs('settings'), safe(async (req, res) => {
  if (req.body?.confirm !== 'SEND') return res.status(400).json({ error: 'confirm', message: 'Type SEND to confirm.' });
  const out = await customerEmails.queue(req.body || {}, req.admin.id);
  if (!out.ok) return res.status(400).json(out);
  await auth.audit({ adminId: req.admin.id, action: 'customer_email_queued', ip: ipOf(req),
    detail: { campaign_id: out.campaign.id, audience: req.body.audience, mobile: req.body.mobile || null,
              subject: out.campaign.subject, recipients: out.campaign.recipients } });
  res.json(out);
}));

router.post('/customer-emails/campaigns/:id/cancel', needs('settings'), safe(async (req, res) => {
  const out = await customerEmails.cancel(req.params.id);
  await auth.audit({ adminId: req.admin.id, action: 'customer_email_cancelled', ip: ipOf(req),
    detail: { campaign_id: req.params.id, cancelled: out.cancelled } });
  res.json(out);
}));

/* ──────────────────────── support tickets (user, 2026-09-23) ──────────── */

const tickets = require('../support/tickets');

router.get('/tickets', safe(async (req, res) => {
  const status = ['open', 'replied', 'closed'].includes(req.query.status) ? req.query.status : null;
  res.json(await tickets.list({ status, q: req.query.q || '' }));
}));

/*
 * The answer goes back to the chat it came from. Outside the 24-hour window
 * that has to be the approved template, so the reply is recorded whether or
 * not it could be delivered — an answer that did not send is still an answer
 * the panel must show as given.
 */
router.post('/tickets/:id/reply', needs('settings'), safe(async (req, res) => {
  const out = await tickets.reply(String(req.params.id).replace(/\D/g, '') || '0',
    req.body?.text, req.admin.id);
  if (!out.ok) return res.status(400).json(out);
  await auth.audit({ adminId: req.admin.id, action: 'ticket_replied', ip: ipOf(req),
    detail: { ticket: out.ticket_no, delivered: out.delivered, reason: out.reason || null } });
  res.json(out);
}));

router.post('/tickets/:id/close', needs('settings'), safe(async (req, res) => {
  await db.query(`UPDATE contact_messages SET status = 'closed' WHERE id = $1`,
    [String(req.params.id).replace(/\D/g, '') || '0']);
  await auth.audit({ adminId: req.admin.id, action: 'ticket_closed', ip: ipOf(req),
    detail: { id: req.params.id } });
  res.json({ ok: true });
}));

/* ───────────────────── WhatsApp template broadcasts (user, 2026-09-23) ── */

const broadcasts = require('../admin/broadcasts');

/* The approved templates, the people who can be sent to, and what has gone. */
router.get('/broadcasts', safe(async (req, res) => {
  res.json({
    templates: await broadcasts.templates({ refresh: req.query.refresh === '1' }),
    recipients: await broadcasts.recipients({ filter: req.query.filter || 'all', q: req.query.q || '' }),
    broadcasts: await broadcasts.list(),
    // Which field fills which blank, per template — never a general guess.
    defaults: await broadcasts.defaults(),
    whatsapp_enabled: require('../config').config.whatsapp.enabled,
    test_mode: require('../config').config.whatsapp.allowedRecipients,
  });
}));

/*
 * Record Meta's decision about a template. Needed while the API token belongs
 * to a deleted app and the live list cannot be read; once it can, Meta's
 * answer overwrites this on every refresh.
 */
router.post('/broadcasts/templates/status', needs('settings'), safe(async (req, res) => {
  const out = await broadcasts.setStatus(req.body?.name, req.body?.language || 'en', req.body?.status);
  if (!out.ok) return res.status(400).json(out);
  await auth.audit({ adminId: req.admin.id, action: 'template_status_set', ip: ipOf(req),
    detail: { template: req.body?.name, language: req.body?.language || 'en', status: req.body?.status } });
  res.json(out);
}));

router.get('/broadcasts/:id/targets', safe(async (req, res) =>
  res.json({ targets: await broadcasts.targets(String(req.params.id).replace(/\D/g, '') || '0') })));

/* What each chosen customer would receive, before anything is sent. */
router.post('/broadcasts/preview', needs('settings'), safe(async (req, res) =>
  res.json(await broadcasts.preview(req.body || {}))));

/* Send: typed confirmation, audited. Queued, then sent a few a minute. */
router.post('/broadcasts/send', needs('settings'), safe(async (req, res) => {
  if (req.body?.confirm !== 'SEND') return res.status(400).json({ error: 'confirm', message: 'Type SEND to confirm.' });
  const out = await broadcasts.queue(req.body || {}, req.admin.id);
  if (!out.ok) return res.status(400).json(out);
  await auth.audit({ adminId: req.admin.id, action: 'broadcast_queued', ip: ipOf(req),
    detail: { broadcast_id: out.id, template: req.body.template_name,
              language: req.body.language, recipients: out.recipients } });
  res.json(out);
}));

router.post('/broadcasts/:id/cancel', needs('settings'), safe(async (req, res) => {
  const out = await broadcasts.cancel(String(req.params.id).replace(/\D/g, '') || '0');
  await auth.audit({ adminId: req.admin.id, action: 'broadcast_cancelled', ip: ipOf(req),
    detail: { broadcast_id: req.params.id, stopped: out.stopped } });
  res.json(out);
}));

/* ────────────────────────────── free reports, one by one (2026-09-21) ── */

const freeReports = require('../admin/freeReports');

router.get('/free-reports', safe(async (req, res) => {
  const states = ['available', 'used', 'expired', 'revoked'];
  res.json(await freeReports.list({ state: states.includes(req.query.state) ? req.query.state : null, q: req.query.q || '' }));
}));

router.get('/free-reports/customer/:id', safe(async (req, res) => {
  const out = await freeReports.customer(String(req.params.id).replace(/\D/g, '') || '0');
  if (!out) return res.status(404).json({ error: 'not_found', message: 'Customer not found.' });
  res.json(out);
}));

/* ───────────────── report access, per customer and vehicle (owner, rare) ── */

const reportAccessOn = async () =>
  String(await settings.get('admin_report_access_enabled', 'true')).toLowerCase() !== 'false';

/* One customer's vehicles, and whether each has a full report right now. */
router.get('/report-access', needs('admins'), safe(async (req, res) => {
  if (!(await reportAccessOn())) return res.status(403).json({ error: 'off', message: 'Report access is switched off in Settings.' });
  const m = String(req.query.mobile || '').replace(/\D/g, '').slice(-10);
  if (m.length !== 10) return res.status(400).json({ error: 'mobile', message: 'Enter the customer\'s 10-digit mobile number.' });
  const u = await db.one(
    `SELECT id, mobile, coalesce(display_name, wa_profile_name) AS name, email, deactivated_at, created_at
       FROM users WHERE mobile = $1`, [m]);
  if (!u) return res.status(404).json({ error: 'not_found', message: 'No customer with that number.' });
  const { rows } = await db.query(
    `SELECT v.reg_no, v.maker, v.model, uv.last_checked_at,
            r.id AS report_id, r.report_number, r.valid_until,
            p.gateway, p.amount_paise, p.raw->>'free' AS free_source,
            s.ends_on AS alerts_until
       FROM user_vehicles uv
       JOIN vehicles v ON v.id = uv.vehicle_id
       LEFT JOIN LATERAL (SELECT * FROM vehicle_reports vr WHERE vr.user_id = uv.user_id AND vr.reg_no = v.reg_no
                            AND vr.valid_until > now() ORDER BY vr.id DESC LIMIT 1) r ON true
       LEFT JOIN payments p ON p.id = r.payment_id
       LEFT JOIN LATERAL (SELECT ends_on FROM subscriptions su WHERE su.user_id = uv.user_id AND su.vehicle_id = v.id
                            AND su.is_active ORDER BY su.ends_on DESC LIMIT 1) s ON true
      WHERE uv.user_id = $1
      ORDER BY uv.last_checked_at DESC NULLS LAST`, [u.id]);
  res.json({ customer: { ...u, id: String(u.id) },
    vehicles: rows.map((r) => ({ ...r, report_id: r.report_id ? String(r.report_id) : null,
      access: r.report_id ? (r.gateway === 'free' ? `free (${r.free_source || 'granted'})` : 'paid') : 'none' })) });
}));

/* Grant a free full report (GaadiPe loses the Rs.19). Typed confirmation and a reason, audited. */
router.post('/report-access/grant', needs('admins'), safe(async (req, res) => {
  if (!(await reportAccessOn())) return res.status(403).json({ error: 'off', message: 'Report access is switched off in Settings.' });
  if (req.body?.confirm !== 'GRANT') return res.status(400).json({ error: 'confirm', message: 'Type GRANT to confirm.' });
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (reason.length < 5) return res.status(400).json({ error: 'reason', message: 'Please give a reason (at least 5 characters).' });
  const parsed = plate.parse(req.body?.reg_no);
  if (!parsed.ok) return res.status(400).json({ error: 'bad_plate', message: parsed.error });
  const u = await db.one(`SELECT id FROM users WHERE id = $1`, [String(req.body?.user_id || '0').replace(/\D/g, '') || '0']);
  if (!u) return res.status(404).json({ error: 'not_found', message: 'Customer not found.' });
  const out = await require('../pay/free').issueFree({ userId: u.id, regNo: parsed.regNo, source: 'admin',
    adminId: req.admin.id, reason, ctx: { ip: req.ip } });
  await auth.audit({ adminId: req.admin.id, action: 'grant_report', ip: ipOf(req),
    detail: { user_id: String(u.id), reg_no: parsed.regNo, reason, ok: out.ok, already: Boolean(out.already), error: out.error || null } });
  if (!out.ok) return res.status(503).json({ error: out.error, message: out.error === 'not_checked'
    ? 'That vehicle has never been checked — check it first.' : 'The report could not be issued right now. Please try again.' });
  res.json({ ok: true, already: Boolean(out.already), report_id: String(out.report.id) });
}));

/* Take a full report away: download, alerts and daily emails stop now. Typed confirmation, audited. */
router.post('/report-access/revoke', needs('admins'), safe(async (req, res) => {
  if (!(await reportAccessOn())) return res.status(403).json({ error: 'off', message: 'Report access is switched off in Settings.' });
  if (req.body?.confirm !== 'REVOKE') return res.status(400).json({ error: 'confirm', message: 'Type REVOKE to confirm.' });
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (reason.length < 5) return res.status(400).json({ error: 'reason', message: 'Please give a reason (at least 5 characters).' });
  const parsed = plate.parse(req.body?.reg_no);
  if (!parsed.ok) return res.status(400).json({ error: 'bad_plate', message: parsed.error });
  const userId = String(req.body?.user_id || '').replace(/\D/g, '');
  const out = await require('../pay/free').revoke({ userId, regNo: parsed.regNo, adminId: req.admin.id, reason });
  await auth.audit({ adminId: req.admin.id, action: 'revoke_report', ip: ipOf(req),
    detail: { user_id: userId, reg_no: parsed.regNo, reason, ...out } });
  if (!out.ok) return res.status(404).json({ error: out.error, message: 'Vehicle not found.' });
  res.json(out);
}));

module.exports = router;
