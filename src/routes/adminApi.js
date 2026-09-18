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

/* ------------------------------------------------------------- signing in */

router.post('/session/otp', safe(async (req, res) => {
  const out = await auth.requestCode({ mobile: req.body?.mobile, ip: ipOf(req) });
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
  next();
}));

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
             can: auth.ROLES[req.admin.role] || [] });
}));

router.delete('/session', safe(async (req, res) => {
  await auth.signOut(tokenOf(req), { ip: ipOf(req) });
  res.json({ ok: true });
}));

/* -------------------------------------------------------------- the numbers */

router.get('/dashboard', safe(async (_req, res) => res.json(await stats.dashboard())));

router.get('/series', safe(async (req, res) => res.json(
  await stats.series({ grain: req.query.grain, days: Number(req.query.days) || 30 }))));

router.get('/funnel', safe(async (req, res) => res.json(
  await stats.funnel({ days: Number(req.query.days) || 30 }))));

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
  }));
}));

router.get('/customers/:id', safe(async (req, res) => {
  const out = await customers.detail(req.params.id);
  if (!out) return res.status(404).json({ error: 'not_found', message: 'No such customer.' });
  // Reading someone's file is itself an action worth recording.
  await auth.audit({ adminId: req.admin.id, action: 'view_customer', ip: ipOf(req),
                     detail: { user_id: req.params.id, mobile: out.user.mobile } });
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
  await auth.audit({ adminId: req.admin.id, action: 'view_thread', ip: ipOf(req),
                     detail: { mobile: req.params.mobile } });
  res.json({ rows });
}));

/* Polled every few seconds — kept out of the audit, or the audit becomes noise. */
router.get('/live/pulse', safe(async (req, res) => res.json(
  await live.pulse({ sinceMessageId: req.query.since || null }))));

router.get('/live/activity', safe(async (req, res) => res.json({
  rows: await live.activity({ limit: Number(req.query.limit) || 50 }),
})));

/* --------------------------------------------------------------- vehicles */

router.get('/vehicles', safe(async (req, res) => {
  const term = String(req.query.q || '').trim();
  const p = term ? plate.normalize(term) : '';
  const { rows } = await db.query(
    `SELECT v.id, v.reg_no, v.maker, v.model, v.fuel, v.vehicle_class, v.rc_status,
            v.insurance_upto, v.pucc_upto, v.fitness_upto, v.tax_upto, v.permit_upto,
            v.financer, v.blacklist_status, v.last_seen_at,
            (SELECT count(*) FROM user_vehicles uv WHERE uv.vehicle_id = v.id) AS checked_by,
            (SELECT count(*) FROM watches w WHERE w.vehicle_id = v.id AND w.is_active) AS watchers,
            EXISTS (SELECT 1 FROM blocks b WHERE b.kind = 'vehicle'
                      AND b.value = v.reg_no AND b.released_at IS NULL) AS blocked,
            count(*) OVER () AS total_rows
       FROM vehicles v
      WHERE ($1 = '' OR v.reg_no LIKE '%' || $1 || '%')
      ORDER BY v.last_seen_at DESC NULLS LAST
      LIMIT $2 OFFSET $3`,
    [p, Math.min(200, Number(req.query.limit) || 50), Number(req.query.offset) || 0]);
  res.json({
    total: rows[0] ? Number(rows[0].total_rows) : 0,
    rows: rows.map(({ total_rows, ...r }) => ({ ...r, id: String(r.id),
      checked_by: Number(r.checked_by), watchers: Number(r.watchers) })),
  });
}));

router.get('/vehicles/:regNo', safe(async (req, res) => {
  const { regNo, ok } = plate.parse(req.params.regNo);
  if (!ok) return res.status(400).json({ error: 'bad_plate', message: 'That is not a vehicle number.' });

  const vehicle = await db.one(`SELECT * FROM vehicles WHERE reg_no = $1`, [regNo]);
  if (!vehicle) return res.status(404).json({ error: 'not_found', message: 'Not checked here yet.' });

  const [snapshots, watchers, reports, checks] = await Promise.all([
    db.query(`SELECT dataset, data, source, fetched_at, expires_at
                FROM vehicle_snapshots WHERE vehicle_id = $1`, [vehicle.id]),
    db.query(`SELECT uv.user_id, u.mobile, u.wa_profile_name AS name, uv.relation,
                     uv.check_count, uv.last_checked_at,
                     EXISTS (SELECT 1 FROM watches w WHERE w.user_id = uv.user_id
                               AND w.vehicle_id = uv.vehicle_id AND w.is_active) AS watching
                FROM user_vehicles uv JOIN users u ON u.id = uv.user_id
               WHERE uv.vehicle_id = $1 ORDER BY uv.last_checked_at DESC`, [vehicle.id]),
    db.query(`SELECT id, report_number, created_at, valid_until, user_id
                FROM vehicle_reports WHERE reg_no = $1 ORDER BY id DESC`, [regNo]),
    db.query(`SELECT dataset, provider_path, cache_hit, outcome, duration_ms, created_at
                FROM api_calls WHERE reg_no = $1 ORDER BY id DESC LIMIT 50`, [regNo]),
  ]);

  await auth.audit({ adminId: req.admin.id, action: 'view_vehicle', ip: ipOf(req),
                     detail: { reg_no: regNo } });

  res.json({
    vehicle: { ...vehicle, id: String(vehicle.id) },
    snapshots: Object.fromEntries(snapshots.rows.map(s => [s.dataset, s])),
    watchers: watchers.rows.map(w => ({ ...w, user_id: String(w.user_id) })),
    reports: reports.rows.map(r => ({ ...r, id: String(r.id), user_id: String(r.user_id) })),
    calls: checks.rows,
    blocked: await blocks.isBlocked('vehicle', regNo),
  });
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
  if (!row || !row.pdf_path || !fs.existsSync(row.pdf_path)) {
    return res.status(404).json({ error: 'not_found', message: 'That file is not on the server.' });
  }
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
            u.id AS user_id, u.wa_profile_name AS name
       FROM feedback f LEFT JOIN users u ON u.id = f.user_id
      ORDER BY f.id DESC LIMIT $1`, [Math.min(200, Number(req.query.limit) || 100)]);
  res.json({ rows: rows.map(r => ({ ...r, id: String(r.id),
                                    user_id: r.user_id ? String(r.user_id) : null })) });
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
    `SELECT a.id, a.action, a.detail, a.ip, a.created_at, u.name, u.mobile
       FROM admin_audit a LEFT JOIN admin_users u ON u.id = a.admin_id
      WHERE ($1 = '' OR a.action = $1)
      ORDER BY a.id DESC LIMIT $2 OFFSET $3`,
    [String(req.query.action || ''), Math.min(200, Number(req.query.limit) || 100),
     Number(req.query.offset) || 0]);
  res.json({ rows: rows.map(r => ({ ...r, id: String(r.id) })) });
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

module.exports = router;
