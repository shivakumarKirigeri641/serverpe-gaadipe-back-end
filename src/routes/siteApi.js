/**
 * src/routes/siteApi.js — the JSON API behind gaadipe.in.
 *
 *   POST   /site/api/session/otp      ask for a sign-in code (SMS)
 *   POST   /site/api/session/verify   exchange the code for a token
 *   GET    /site/api/session          who am I
 *   DELETE /site/api/session          sign out
 *
 *   GET    /site/api/me               profile and totals
 *   PUT    /site/api/me               name and email
 *   POST   /site/api/me/deactivate    withdraw consent
 *
 *   GET    /site/api/vehicles         my vehicles
 *   GET    /site/api/vehicles/:regNo  one vehicle — full if paid for, else basic
 *   POST   /site/api/check            check any vehicle (basic, quota-limited)
 *   POST   /site/api/buy              start a payment for the full report
 *
 *   GET    /site/api/reports          my reports · /:id/file the PDF
 *   GET    /site/api/invoices         my invoices · /:id/file the PDF
 *   GET    /site/api/pricing          what a report costs, for the page to show
 *
 * THE SAME RULES AS THE BOT, DELIBERATELY REUSED: the quota that decides how
 * many free checks someone gets, the plate parser, the block list and the
 * basic-versus-paid rule are all the modules WhatsApp already uses. A second
 * copy of any of them would eventually disagree with the first, and the
 * customer would be the one to find out.
 */

const express = require('express');
const fs = require('fs');
const db = require('../db');
const auth = require('../site/auth');
const view = require('../site/vehicleView');
const plate = require('../util/plate');
const quota = require('../util/quota');
const blocks = require('../admin/blocks');
const gateway = require('../vehicle/gateway');
const store = require('../vehicle/store');
const reports = require('../pay/report');
const billing = require('../pay/billing');
const razorpay = require('../pay/razorpay');
const settings = require('../util/settings');

const router = express.Router();

const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error('[siteApi] %s %s: %s', req.method, req.path, e.stack || e.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
});

const tokenOf = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '');

/* ---------------------------------------------------------------- public */

/** What a report costs, so the page never hard-codes a price that can change. */
router.get('/pricing', safe(async (_req, res) => {
  const plan = await billing.reportPlan();
  const validDays = await settings.num('report_valid_days', 7);
  res.json({
    price_paise: plan?.price_paise ?? null,
    duration_days: plan?.duration_days ?? 28,
    report_valid_days: validDays,
    free_checks_per_day: await settings.num('free_checks_per_day', 10),
  });
}));

router.post('/session/otp', safe(async (req, res) => {
  const out = await auth.requestCode({ mobile: req.body?.mobile, ip: req.ip });
  if (!out.ok) return res.status(out.error === 'wait' ? 429 : 400).json(out);
  res.json(out);
}));

router.post('/session/verify', safe(async (req, res) => {
  const out = await auth.verifyCode({
    mobile: req.body?.mobile, code: req.body?.code,
    ip: req.ip, userAgent: req.get('user-agent'),
  });
  if (!out.ok) return res.status(401).json(out);
  res.json(out);
}));

/* ------------------------------------------------------------- signed in */

router.use(safe(async (req, res, next) => {
  const session = await auth.sessionFor(tokenOf(req));
  if (!session) {
    return res.status(401).json({ error: 'signed_out', message: 'Please sign in again.' });
  }
  req.user = session.user;
  next();
}));

router.get('/session', safe(async (req, res) =>
  res.json({ ok: true, user: auth.publicUser(req.user) })));

router.delete('/session', safe(async (req, res) => {
  await auth.signOut(tokenOf(req));
  res.json({ ok: true });
}));

router.get('/me', safe(async (req, res) => {
  const totals = await db.one(
    `SELECT
       (SELECT count(*) FROM user_vehicles WHERE user_id = $1)                      AS vehicles,
       (SELECT count(*) FROM vehicle_reports WHERE user_id = $1)                    AS reports,
       (SELECT count(*) FROM invoices WHERE user_id = $1)                           AS invoices,
       (SELECT coalesce(sum(amount_paise), 0) FROM payments
         WHERE user_id = $1 AND status = 'paid')                                    AS paid_paise,
       (SELECT count(*) FROM watches WHERE user_id = $1 AND is_active)              AS watching`,
    [req.user.id]);

  res.json({
    user: auth.publicUser(req.user),
    totals: {
      vehicles: Number(totals.vehicles), reports: Number(totals.reports),
      invoices: Number(totals.invoices), paid_paise: Number(totals.paid_paise),
      watching: Number(totals.watching),
    },
  });
}));

router.put('/me', safe(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80) || null;
  const email = String(req.body?.email || '').trim().slice(0, 160) || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'bad_email', message: 'That email address does not look right.' });
  }
  const { rows } = await db.query(
    `UPDATE users SET display_name = coalesce($2, display_name),
            email = coalesce($3, email), modified_at = now()
      WHERE id = $1 RETURNING *`, [req.user.id, name, email]);
  res.json({ ok: true, user: auth.publicUser(rows[0]) });
}));

/**
 * Withdraw consent.
 *
 * The response says exactly what happened, including what was NOT deleted:
 * "your account is closed" while the invoices remain would be a promise we did
 * not keep, and a customer finding that out later is worse than saying it now.
 */
router.post('/me/deactivate', safe(async (req, res) => {
  await auth.deactivate(req.user.id, { reason: String(req.body?.reason || '').slice(0, 500) });
  res.json({
    ok: true,
    message: 'Your account is deactivated. Monitoring and alerts have stopped and you '
      + 'have been signed out. Your tax invoices are kept, as the law requires. '
      + 'Sign in again any time with the same number to reopen the account.',
  });
}));

/* -------------------------------------------------------------- vehicles */

router.get('/vehicles', safe(async (req, res) => {
  const { rows } = await db.query(
    `SELECT v.reg_no, v.maker, v.model, v.fuel, v.vehicle_class, v.rc_status,
            v.insurance_upto, v.pucc_upto, v.fitness_upto, v.tax_upto, v.permit_upto,
            uv.check_count, uv.last_checked_at,
            EXISTS (SELECT 1 FROM watches w
                     WHERE w.user_id = uv.user_id AND w.vehicle_id = v.id AND w.is_active) AS watched,
            (SELECT max(w.expires_at) FROM watches w
              WHERE w.user_id = uv.user_id AND w.vehicle_id = v.id AND w.is_active) AS watched_until,
            (SELECT r.id FROM vehicle_reports r
              WHERE r.user_id = uv.user_id AND r.reg_no = v.reg_no
                AND r.valid_until > now() ORDER BY r.id DESC LIMIT 1) AS report_id,
            (SELECT r.valid_until FROM vehicle_reports r
              WHERE r.user_id = uv.user_id AND r.reg_no = v.reg_no
                AND r.valid_until > now() ORDER BY r.id DESC LIMIT 1) AS report_until
       FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
      WHERE uv.user_id = $1
      ORDER BY uv.last_checked_at DESC NULLS LAST`, [req.user.id]);

  res.json({
    rows: rows.map(r => ({
      ...r,
      report_id: r.report_id ? String(r.report_id) : null,
      check_count: Number(r.check_count || 0),
    })),
  });
}));

/**
 * One vehicle, as this customer may see it.
 *
 * Cache-first through the same gateway the bot uses, so the site and WhatsApp
 * never disagree about a vehicle — and a customer opening their own vehicle
 * twice in a minute does not spend two lookups.
 */
router.get('/vehicles/:regNo', safe(async (req, res) => {
  const parsed = plate.parse(req.params.regNo);
  if (!parsed.ok) return res.status(400).json({ error: 'bad_plate', message: parsed.error });

  const paid = await reports.validFor(req.user.id, parsed.regNo);
  const data = await gateway.full(parsed.regNo, paid ? { challans: 'all' } : {});
  if (!data?.success) {
    return res.status(data?.error === 'vehicle_not_found' ? 404 : 503).json({
      error: data?.error || 'unavailable',
      message: data?.message || 'The Government records service is busy. Please try again shortly.',
    });
  }

  res.json({
    vehicle: paid ? view.full(data) : view.basic(data),
    report: paid ? { id: String(paid.id), number: paid.report_number, valid_until: paid.valid_until } : null,
  });
}));

/**
 * Check any vehicle — the free look.
 *
 * Quota-limited by the same rules as WhatsApp, and never more than the basic
 * view. `can_buy` tells the page whether to offer the report, so the button and
 * the server agree about what happens next.
 */
router.post('/check', safe(async (req, res) => {
  const parsed = plate.parse(req.body?.reg_no);
  if (!parsed.ok) return res.status(400).json({ error: 'bad_plate', message: parsed.error });

  if (await blocks.isBlocked('vehicle', parsed.regNo)) {
    return res.status(403).json({ error: 'blocked',
      message: 'This vehicle cannot be checked. If it is yours, please write to support@gaadipe.in.' });
  }

  const q = await quota.check(req.user.id, parsed.regNo);
  if (!q.allowed) {
    return res.status(429).json({
      error: 'quota',
      message: q.reason === 'burst'
        ? 'That is a lot of checks very quickly — please wait a minute and try again.'
        : `You have used your ${q.limit} free checks for today. They reset tomorrow.`,
    });
  }

  const data = await gateway.full(parsed.regNo);
  await quota.record(req.user.id, parsed.regNo, { repeat: q.repeat, found: data?.success === true });

  if (!data?.success) {
    return res.status(data?.error === 'vehicle_not_found' ? 404 : 503).json({
      error: data?.error || 'unavailable',
      message: data?.error === 'vehicle_not_found'
        ? `No Government record was found for ${parsed.regNo}. Very new vehicles can take a few weeks to appear.`
        : 'The Government records service is busy. Please try again in a minute.',
    });
  }

  await store.record(req.user.id, data).catch(e => console.error('[site] store:', e.message));

  const paid = await reports.validFor(req.user.id, parsed.regNo);
  const plan = await billing.reportPlan();
  res.json({
    vehicle: paid ? view.full(data) : view.basic(data),
    report: paid ? { id: String(paid.id), number: paid.report_number, valid_until: paid.valid_until } : null,
    can_buy: Boolean(plan && razorpay.configured() && !paid),
    price_paise: plan?.price_paise ?? null,
  });
}));

/**
 * Buy the full report for a vehicle.
 *
 * Creates the same payment row and Razorpay order the WhatsApp flow creates, and
 * hands back the same hosted checkout page — so a payment started on the site is
 * activated, invoiced and delivered by exactly the code that has already been
 * proved on WhatsApp, including the webhook and the reconciler.
 */
router.post('/buy', safe(async (req, res) => {
  const parsed = plate.parse(req.body?.reg_no);
  if (!parsed.ok) return res.status(400).json({ error: 'bad_plate', message: parsed.error });

  const existing = await reports.validFor(req.user.id, parsed.regNo);
  if (existing) {
    return res.json({ ok: true, already: true, report_id: String(existing.id) });
  }

  const vehicle = await db.one(`SELECT id FROM vehicles WHERE reg_no = $1`, [parsed.regNo]);
  if (!vehicle) {
    return res.status(400).json({ error: 'not_checked',
      message: 'Please check the vehicle first, then buy the report.' });
  }

  const plan = await billing.reportPlan();
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!plan || !razorpay.configured() || !base) {
    console.error('[site] cannot sell a report: plan=%s razorpay=%s base=%s',
      Boolean(plan), razorpay.configured(), Boolean(base));
    return res.status(503).json({ error: 'unavailable',
      message: 'Payments are not available right now. Please try again shortly.' });
  }

  // An unpaid order for the same vehicle is reused rather than opened twice.
  let row = await db.one(
    `SELECT * FROM payments
      WHERE user_id = $1 AND plan_id = $2 AND status = 'created'
        AND checkout_token IS NOT NULL
        AND (raw->>'vehicle_id')::bigint = $3
        AND created_at > now() - interval '1 hour'
      ORDER BY id DESC LIMIT 1`, [req.user.id, plan.id, vehicle.id]);

  if (!row) {
    await db.query(
      `INSERT INTO event_log (user_id, vehicle_id, kind, detail)
            VALUES ($1, $2, 'purchase_consent', $3)`,
      [req.user.id, vehicle.id, JSON.stringify({
        mobile: req.user.mobile, reg_no: parsed.regNo, amount_paise: plan.price_paise,
        plan: plan.code, channel: 'web', documents: ['terms', 'refund', 'privacy'],
        ip: req.ip, user_agent: req.get('user-agent') || null, at: new Date().toISOString() })]);

    const pending = await billing.createPending({
      userId: req.user.id, planId: plan.id, amountPaise: plan.price_paise, vehicleId: vehicle.id,
    });

    let order;
    try {
      order = await razorpay.createOrder({
        amountPaise: plan.price_paise,
        receipt: `gp-${pending.id}`,
        notes: { reference_id: `gp-${pending.id}`, reg_no: parsed.regNo,
                 mobile: req.user.mobile, plan: plan.code, channel: 'web' },
      });
      if (!order?.id) throw new Error('no order id returned');
    } catch (e) {
      console.error('[site] order creation failed:', e.message);
      return res.status(502).json({ error: 'gateway',
        message: 'We could not start the payment just now. Please try again in a minute.' });
    }

    const token = require('crypto').randomBytes(16).toString('hex');
    row = (await db.query(
      `UPDATE payments SET order_id = $2, checkout_token = $3,
              raw = COALESCE(raw,'{}'::jsonb) || $4::jsonb
        WHERE id = $1 RETURNING *`,
      [pending.id, order.id, token, JSON.stringify({ order_id: order.id, channel: 'web' })])).rows[0];
  }

  res.json({ ok: true, pay_url: `${base}/pay/${row.checkout_token}`,
             amount_paise: row.amount_paise });
}));

/* --------------------------------------------------- reports and invoices */

router.get('/reports', safe(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, report_number, reg_no, created_at, valid_until, pdf_path
       FROM vehicle_reports WHERE user_id = $1 ORDER BY id DESC`, [req.user.id]);
  res.json({
    rows: rows.map(({ pdf_path, ...r }) => ({
      ...r, id: String(r.id),
      downloadable: Boolean(pdf_path) && r.valid_until && new Date(r.valid_until) > new Date(),
    })),
  });
}));

router.get('/invoices', safe(async (req, res) => {
  const { rows } = await db.query(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.base_paise, i.total_paise,
            i.cgst_paise, i.sgst_paise, i.igst_paise, i.pdf_path, v.reg_no
       FROM invoices i
       LEFT JOIN subscriptions s ON s.id = i.subscription_id
       LEFT JOIN vehicles v ON v.id = s.vehicle_id
      WHERE i.user_id = $1 ORDER BY i.id DESC`, [req.user.id]);
  res.json({
    rows: rows.map(({ pdf_path, ...r }) => ({ ...r, id: String(r.id), downloadable: Boolean(pdf_path) })),
  });
}));

/**
 * A document belonging to this customer.
 *
 * The row is fetched BY user_id as well as by id, so an id from somebody else's
 * account is a 404 rather than a leak — the commonest way an account area
 * gives away other people's documents.
 */
const sendPdf = ({ table, column, mustBeValid }) => safe(async (req, res) => {
  const row = await db.one(
    `SELECT ${column} AS number, pdf_path${mustBeValid ? ', valid_until' : ''}
       FROM ${table} WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);

  if (!row || !row.pdf_path || !fs.existsSync(row.pdf_path)) {
    return res.status(404).json({ error: 'not_found', message: 'That document is not available.' });
  }
  if (mustBeValid && (!row.valid_until || new Date(row.valid_until) <= new Date())) {
    return res.status(410).json({ error: 'expired',
      message: 'The download period for this report has ended. Check the vehicle again for a fresh one.' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${row.number}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(row.pdf_path).pipe(res);
});

router.get('/reports/:id/file', sendPdf({ table: 'vehicle_reports', column: 'report_number', mustBeValid: true }));
router.get('/invoices/:id/file', sendPdf({ table: 'invoices', column: 'invoice_number' }));

module.exports = router;
