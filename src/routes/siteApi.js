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
const device = require('../site/device');
const quota = require('../util/quota');
const blocks = require('../admin/blocks');
const gateway = require('../vehicle/gateway');
const store = require('../vehicle/store');
const reports = require('../pay/report');
const billing = require('../pay/billing');
const razorpay = require('../pay/razorpay');
const settings = require('../util/settings');
const activity = require('../site/activity');
const customerMail = require('../mail/customer');
const referrals = require('../referrals/quizpe');

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
router.get('/declaration', (req, res) => {
  const language = langOf(req.query.lang);
  res.json({ text: DECLARATIONS[language], language });
});

router.get('/pricing', safe(async (_req, res) => {
  const plan = await billing.reportPlan();
  const validDays = await settings.num('report_valid_days', 7);
  res.json({
    price_paise: plan?.price_paise ?? null,
    duration_days: plan?.duration_days ?? 28,
    report_valid_days: validDays,
    free_checks_per_day: await settings.num('free_checks_per_day', 10),
    // How a full report is unlocked: pay | both | refer (user, 2026-09-21).
    unlock: await unlockMode(),
  });
}));

/* ────────────────────────────────────────── how a full report is unlocked ── */

const unlockMode = async () => {
  const m = String(await settings.get('report_unlock', 'both')).toLowerCase();
  return ['pay', 'both', 'refer'].includes(m) ? m : 'both';
};

/**
 * What the vehicle page may offer (user, 2026-09-21): pay Rs.19, and/or refer
 * QuizPe to a parent for a free report — per report_unlock — and whether this
 * customer already holds a free report to use.
 */
async function offerFor(req, plan, paid) {
  const mode = await unlockMode();
  const referralsOn = String(await settings.get('referral_enabled', 'true')).toLowerCase() !== 'false';
  return {
    unlock: mode,
    can_buy: Boolean(plan && razorpay.configured() && !paid && mode !== 'refer'),
    can_refer: Boolean(!paid && referralsOn && mode !== 'pay'),
    free_credits: paid ? 0 : await referrals.availableCredits(req.user.id),
    price_paise: plan?.price_paise ?? null,
  };
}

/*
 * CONTACT US (user, 2026-09-18). Public — a person with a problem may not be
 * able to sign in. Stored, and emailed to the admin by the notify job. Five
 * messages an hour from one IP; a hidden field that people never fill catches
 * the robots that do. Signed in, the message is tied to the account.
 */
router.post('/contact', safe(async (req, res) => {
  const b = req.body || {};
  const clip = (v, n) => String(v ?? '').trim().slice(0, n);
  if (clip(b.website, 200)) return res.json({ ok: true });            // the trap: say nothing
  const name = clip(b.name, 80);
  const message = clip(b.message, 3000);
  const email = clip(b.email, 160);
  const mobile = String(b.mobile || '').replace(/\D/g, '').slice(-10);
  const language = b.language === 'hi' ? 'hi' : 'en';
  const hi = language === 'hi';

  if (name.length < 2) return res.status(400).json({ error: 'bad_name', message: hi ? 'कृपया अपना नाम लिखें।' : 'Please tell us your name.' });
  if (message.length < 5) return res.status(400).json({ error: 'bad_message', message: hi ? 'कृपया अपना संदेश लिखें।' : 'Please write your message.' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'bad_email', message: hi ? 'ईमेल पता सही नहीं लगता।' : 'That email address does not look right.' });
  if (mobile && !/^[6-9]\d{9}$/.test(mobile)) return res.status(400).json({ error: 'bad_mobile', message: hi ? 'कृपया दस अंकों का मोबाइल नंबर लिखें।' : 'Please enter a ten-digit mobile number.' });
  if (!email && !mobile) return res.status(400).json({ error: 'no_contact', message: hi ? 'जवाब के लिए ईमेल या मोबाइल नंबर दें।' : 'Please give an email or a mobile number so we can reply.' });

  const perHour = await settings.num('contact_per_hour_per_ip', 5);
  const recent = await db.one(
    `SELECT count(*)::int AS n FROM contact_messages WHERE ip IS NOT DISTINCT FROM $1 AND created_at > now() - interval '1 hour'`,
    [req.ip || null]);
  if (recent.n >= perHour) {
    return res.status(429).json({ error: 'too_many', message: hi ? 'बहुत सारे संदेश भेजे गए। कृपया थोड़ी देर बाद कोशिश करें।' : 'Too many messages from here. Please try again a little later.' });
  }

  const session = await auth.sessionFor(tokenOf(req)).catch(() => null);
  const reg = clip(b.reg_no, 14).toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
  await db.query(
    `INSERT INTO contact_messages (name, mobile, email, subject, message, reg_no, user_id, language, ip, user_agent)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [name, mobile || session?.user?.mobile || null, email || session?.user?.email || null, clip(b.subject, 140) || null,
     message, reg, session?.user?.id || null, language, req.ip || null, clip(req.get('user-agent'), 600) || null]);
  res.json({ ok: true, message: hi ? 'धन्यवाद — आपका संदेश हमें मिल गया है। हम जल्द जवाब देंगे।' : 'Thank you — your message has reached us. We will reply soon.' });
}));

router.post('/session/otp', safe(async (req, res) => {
  const out = await auth.requestCode({ mobile: req.body?.mobile, ctx: device.contextOf(req) });
  if (!out.ok) return res.status(out.error === 'wait' ? 429 : 400).json(out);
  res.json(out);
}));

router.post('/session/verify', safe(async (req, res) => {
  const out = await auth.verifyCode({
    mobile: req.body?.mobile, code: req.body?.code, ctx: device.contextOf(req),
  });
  if (!out.ok) return res.status(401).json(out);
  res.json(out);
}));

/*
 * A referral link was tapped: gaadipe.in/q/<code> asks here where to go
 * (user, 2026-09-21). Public — the person tapping is usually not a GaadiPe
 * customer — but a signed-in owner opening their OWN link is told so instead.
 */
router.get('/q/:code', safe(async (req, res) => {
  const token = tokenOf(req);
  const viewer = token ? await auth.sessionFor(token, { ip: req.ip }).catch(() => null) : null;
  res.json(await referrals.resolve(req.params.code, {
    viewer: viewer?.user || null, ip: req.ip, userAgent: req.get('user-agent') }));
}));

/* ------------------------------------------------------------- signed in */

router.use(safe(async (req, res, next) => {
  const session = await auth.sessionFor(tokenOf(req), { ip: req.ip, user_agent: req.get('user-agent'), device_id: req.get('x-gp-device') });
  if (!session) {
    return res.status(401).json({ error: 'signed_out', message: 'Please sign in again.' });
  }
  req.user = session.user;
  req.siteSession = session;
  next();
}));

/* Where the customer is on the site, reported by the page (site/activity.js). */
router.post('/activity', safe(async (req, res) => {
  // One event, or a batch of clicks the page collected (at most 50 a call).
  if (Array.isArray(req.body?.events)) {
    let n = 0;
    for (const ev of req.body.events.slice(0, 50)) if (await activity.fromClient(req, ev || {})) n += 1;
    return res.json({ ok: true, recorded: n });
  }
  const ok = await activity.fromClient(req, req.body || {});
  res.json({ ok });
}));

router.get('/session', safe(async (req, res) =>
  res.json({ ok: true, user: auth.publicUser(req.user) })));

router.delete('/session', safe(async (req, res) => {
  await auth.signOut(tokenOf(req), device.contextOf(req));
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
  // The language alerts are sent in. Only the two Meta has templates for.
  const language = ['en', 'hi'].includes(req.body?.language) ? req.body.language : null;
  // A new address starts unconfirmed and is sent a confirmation link (mail/customer.js).
  const mail = email ? await customerMail.setEmail(req.user.id, email) : { changed: false };
  const { rows } = await db.query(
    `UPDATE users SET display_name = coalesce($2, display_name),
            preferred_language = coalesce($3, preferred_language), modified_at = now()
      WHERE id = $1 RETURNING *`, [req.user.id, name, language]);
  res.json({ ok: true, user: auth.publicUser(rows[0]), email_confirmation_sent: mail.changed });
}));

/* ─────────────────────────────── QuizPe referrals (user, 2026-09-21) ── */

/* My link, what it brought, and my free reports. */
router.get('/referrals', safe(async (req, res) => {
  const out = await referrals.summaryFor(req.user);
  res.json({ ...out, enabled: String(await settings.get('referral_enabled', 'true')).toLowerCase() !== 'false',
             unlock: await unlockMode(),
             monthly_cap: await settings.num('referral_monthly_cap', 10),
             window_days: await settings.num('referral_window_days', 30) });
}));

/* Join the programme: agree that QuizPe may message me (its condition), and get my link. */
router.post('/referrals/join', safe(async (req, res) => {
  const out = await referrals.join(req.user, { consent: req.body?.consent === true,
    name: req.body?.name, email: req.body?.email, ip: req.ip, userAgent: req.get('user-agent') });
  if (!out.ok) return res.status(400).json(out);
  await activity.record(req, { action: 'referral_joined' });
  const fresh = await db.one(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
  res.json({ ...(await referrals.summaryFor(fresh)), user: auth.publicUser(fresh) });
}));

/* Spend a free report on a vehicle — the same declaration as a purchase is required. */
router.post('/credits/use', safe(async (req, res) => {
  const parsed = plate.parse(req.body?.reg_no);
  if (!parsed.ok) return res.status(400).json({ error: 'bad_plate', message: parsed.error });
  if (req.body?.declared !== true) {
    return res.status(400).json({ error: 'declaration_required',
      message: 'Please confirm that this vehicle is yours or that its owner is known to you.' });
  }
  const lang = langOf(req.body?.language);
  const out = await referrals.useCredit(req.user, parsed.regNo, {
    declaration: { mobile: req.user.mobile, documents: ['terms', 'refund', 'privacy'],
      declaration: DECLARATIONS[lang], declaration_language: lang, declaration_en: DECLARATION,
      ip: req.ip, user_agent: req.get('user-agent') || null },
    ctx: { ip: req.ip, user_agent: req.get('user-agent') || null },
  });
  if (!out.ok) return res.status(out.error === 'no_credit' ? 409 : 503).json(out);
  await activity.record(req, { action: 'free_report_used', regNo: parsed.regNo });
  res.json(out);
}));

/*
 * QuizPe may message me — a SEPARATE, OPTIONAL consent (DPDP): never pre-ticked,
 * not a condition of anything, withdrawable here any time. The exact words and
 * the time are recorded.
 */
// One wording, shared with the referral programme (withdrawing it stops the link).
const QUIZPE_CONSENT = referrals.PROGRAMME_CONSENT;
router.put('/me/consents', safe(async (req, res) => {
  const agree = req.body?.quizpe === true;
  const { rows } = await db.query(
    agree
      ? `UPDATE users SET quizpe_consent_at = now(), quizpe_consent_text = $2, quizpe_consent_withdrawn_at = NULL,
                modified_at = now() WHERE id = $1 RETURNING *`
      : `UPDATE users SET quizpe_consent_withdrawn_at = CASE WHEN quizpe_consent_at IS NOT NULL THEN now() END,
                quizpe_consent_at = NULL, modified_at = now() WHERE id = $1 RETURNING *`,
    agree ? [req.user.id, QUIZPE_CONSENT] : [req.user.id]);
  await db.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, $2, $3)`,
    [req.user.id, agree ? 'quizpe_consent_given' : 'quizpe_consent_withdrawn',
     JSON.stringify({ text: QUIZPE_CONSENT, ip: req.ip, user_agent: req.get('user-agent') || null })]);
  res.json({ ok: true, user: auth.publicUser(rows[0]), text: QUIZPE_CONSENT });
}));
router.get('/me/consents', safe(async (req, res) => {
  const u = await db.one(`SELECT quizpe_consent_at FROM users WHERE id = $1`, [req.user.id]);
  res.json({ quizpe: Boolean(u?.quizpe_consent_at), quizpe_at: u?.quizpe_consent_at || null, text: QUIZPE_CONSENT });
}));

/* The confirmation link again, for an address not yet confirmed. At most one every two minutes. */
router.post('/me/email/resend', safe(async (req, res) => {
  const u = await db.one(`SELECT email, email_verified_at FROM users WHERE id = $1`, [req.user.id]);
  if (!u?.email) return res.status(400).json({ error: 'no_email', message: 'Please add your email first.' });
  if (u.email_verified_at) return res.json({ ok: true, already: true });
  const recent = await db.one(
    `SELECT 1 FROM customer_emails WHERE user_id = $1 AND kind = 'confirm' AND created_at > now() - interval '2 minutes'`,
    [req.user.id]);
  if (recent) return res.status(429).json({ error: 'wait', message: 'A link was just sent. Please check your inbox, or try again in two minutes.' });
  await db.query(`INSERT INTO customer_emails (user_id, kind, to_email) VALUES ($1, 'confirm', $2)`, [req.user.id, u.email]);
  res.json({ ok: true });
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
            v.reg_upto, uv.check_count, uv.last_checked_at,
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

  /*
   * THE LIST OBEYS THE PAYWALL TOO. It used to send every expiry date for every
   * vehicle — paid or not — so "My vehicles" quietly showed what the free check
   * was careful to hide. Dates now travel only with a valid report; otherwise
   * the list says which documents have lapsed, by name, and nothing more.
   */
  const report = require('../whatsapp/report');
  const DATES = ['insurance_upto', 'pucc_upto', 'fitness_upto', 'tax_upto', 'permit_upto', 'reg_upto'];
  res.json({
    rows: rows.map((r) => {
      const paid = Boolean(r.report_id);
      const docs = report.documentsOf(r);
      const out = {
        ...r,
        report_id: r.report_id ? String(r.report_id) : null,
        check_count: Number(r.check_count || 0),
        expired: docs.filter(d => d.days < 0).map(d => d.label),
      };
      if (!paid) for (const k of DATES) delete out[k];
      return out;
    }),
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

  // The same offer as a fresh check: a vehicle opened from "My vehicles" is
  // exactly as buyable as one just typed in, and the page should say so.
  const plan = await billing.reportPlan();
  await activity.record(req, { action: paid ? 'view_vehicle_paid' : 'view_vehicle', regNo: parsed.regNo });
  res.json({
    vehicle: paid ? await fullRecord(req, parsed.regNo, data) : view.basic(data),
    report: paid ? { id: String(paid.id), number: paid.report_number, valid_until: paid.valid_until } : null,
    ...(await offerFor(req, plan, paid)),
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

  // Many DIFFERENT vehicles from one account or address in an hour is scraping.
  const scan = await require('../security/guard').noteVehicleCheck(req, parsed.regNo);
  if (!scan.ok) {
    return res.status(429).json({ error: 'too_many_vehicles',
      message: 'You have checked a lot of vehicles in a short time. Please try again in an hour.' });
  }

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

  // A paid customer sees every challan, so the whole list is asked for up front.
  const paid = await reports.validFor(req.user.id, parsed.regNo);
  const data = await gateway.full(parsed.regNo, paid ? { challans: 'all' } : {});
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
  await activity.record(req, { action: paid ? 'check_paid' : 'check', regNo: parsed.regNo });

  const plan = await billing.reportPlan();
  res.json({
    vehicle: paid ? await fullRecord(req, parsed.regNo, data) : view.basic(data),
    report: paid ? { id: String(paid.id), number: paid.report_number, valid_until: paid.valid_until } : null,
    ...(await offerFor(req, plan, paid)),
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
/**
 * THE DECLARATION. The report states that its requester confirmed the vehicle
 * and its owner are known to them; that sentence is only true if it was asked.
 * So it is asked, it cannot be skipped, and the answer is recorded with the
 * exact words shown, the time and the device — a checkbox the browser claims
 * was ticked is not the same as a checkbox the server required.
 */
/*
 * In both languages the site is read in. The customer ticks the words they
 * READ, so those are what is recorded — with the English beside them, because
 * the documents are English and a tax record should not depend on a
 * translation being made later.
 */
/*
 * A PAID RECORD, SERVED (user, 2026-09-18). Two protections on the full record:
 *   · a daily cap per account (full_views_per_day_user). A paying customer opens
 *     a handful; a scraper opens hundreds. Past the cap the basic view is shown
 *     with a note — never an error, since they have paid — the PDF report stays
 *     downloadable, and the admin hears about it.
 *   · the account's watermark (security/watermark.js): the same data, fields in
 *     an order unique to this account, so a leaked copy can be traced.
 */
async function fullRecord(req, regNo, data) {
  const cap = await settings.num('full_views_per_day_user', 25);
  const today = await db.one(
    `SELECT count(*)::int AS n FROM event_log
      WHERE user_id = $1 AND kind = 'full_view'
        AND created_at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
    [req.user.id]);
  if (today.n >= cap) {
    await require('../security/guard').record('full_view_cap', req, {
      surface: 'site', detail: { views_today: today.n, cap, reg_no: regNo } });
    return { ...view.basic(data), limited: true, limit_per_day: cap };
  }
  await db.query(
    `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'full_view', $2)`,
    [req.user.id, JSON.stringify({ reg_no: regNo, ip: req.ip })]);
  return require('../security/watermark').watermark(view.full(data), req.user.id);
}

const DECLARATIONS = {
  en: 'I confirm this vehicle is mine, or that its owner is known to me, and that '
    + 'I am requesting its details for a lawful purpose. I take responsibility for how I use them.',
  hi: 'मैं पुष्टि करता/करती हूँ कि यह वाहन मेरा है, या इसके मालिक को मैं जानता/जानती हूँ, और मैं '
    + 'इसकी जानकारी एक वैध उद्देश्य के लिए माँग रहा/रही हूँ। इसके उपयोग की पूरी ज़िम्मेदारी मेरी है।',
};
const langOf = (v) => (v === 'hi' ? 'hi' : 'en');
const DECLARATION = DECLARATIONS.en;

router.post('/buy', safe(async (req, res) => {
  const parsed = plate.parse(req.body?.reg_no);
  if (!parsed.ok) return res.status(400).json({ error: 'bad_plate', message: parsed.error });

  if (req.body?.declared !== true) {
    return res.status(400).json({ error: 'declaration_required',
      message: 'Please confirm that this vehicle is yours or that its owner is known to you.' });
  }
  // Referral-only mode: reports are unlocked by referring, not by paying.
  if (await unlockMode() === 'refer') {
    return res.status(409).json({ error: 'refer_only',
      message: 'Full reports are unlocked by referring QuizPe to a parent right now.' });
  }

  /*
   * WHO IS BUYING, FOR THE INVOICE (user, 2026-09-18): the name printed under
   * "Billed to", and the state or union territory — the place of supply, which
   * decides CGST+SGST (Karnataka) or IGST (anywhere else). Asked before Pay now,
   * remembered on the account for next time, and kept on the payment so the
   * invoice says what was entered for THIS purchase.
   */
  const { STATES } = require('../pay/invoice');
  const buyerName = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const buyerState = String(req.body?.state_code || '').replace(/\D/g, '').padStart(2, '0');
  if (buyerName.length < 2) {
    return res.status(400).json({ error: 'name_required', message: 'Please enter your name for the invoice.' });
  }
  if (!STATES[buyerState]) {
    return res.status(400).json({ error: 'state_required', message: 'Please choose your state or union territory.' });
  }
  /* THE EMAIL, REQUIRED AT CHECKOUT (user, 2026-09-21): the daily updates the
     report includes go there while GaadiPe has no WhatsApp Business number. */
  const buyerEmail = String(req.body?.email || '').trim();
  if (!customerMail.validEmail(buyerEmail)) {
    return res.status(400).json({ error: 'email_required', message: 'Please enter your email — your daily vehicle updates are sent there.' });
  }
  await customerMail.setEmail(req.user.id, buyerEmail);
  await db.query(
    `UPDATE users SET display_name = $2, state_code = $3, modified_at = now() WHERE id = $1`,
    [req.user.id, buyerName, buyerState]);

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
  // The site opens checkout through its own origin, so a public base URL (a
  // tunnel, the API domain) is not needed for a website purchase.
  if (!plan || !razorpay.configured()) {
    console.error('[site] cannot sell a report: plan=%s razorpay=%s',
      Boolean(plan), razorpay.configured());
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

  /*
   * RECORDED EVERY TIME, not only when a new order is opened. A customer who
   * opens the dialog twice in an hour reuses the unpaid order, and the first
   * version skipped the record on that path — so a payment could complete with
   * no declaration on file for it. The declaration belongs to the act of
   * paying, so every act gets its own row, tied to the payment it covers.
   */
  const consent = async (paymentRowId) => db.query(
    `INSERT INTO event_log (user_id, vehicle_id, kind, detail)
          VALUES ($1, $2, 'purchase_consent', $3)`,
    [req.user.id, vehicle.id, JSON.stringify({
      mobile: req.user.mobile, reg_no: parsed.regNo, amount_paise: plan.price_paise,
      plan: plan.code, channel: 'web', documents: ['terms', 'refund', 'privacy'],
      declaration: DECLARATIONS[langOf(req.body?.language)],
      declaration_language: langOf(req.body?.language),
      declaration_en: DECLARATION,
      declared: true, payment_row: String(paymentRowId),
      ip: req.ip, user_agent: req.get('user-agent') || null, at: new Date().toISOString() })]);

  if (!row) {
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

  await consent(row.id);
  await activity.record(req, { action: 'pay_start', regNo: parsed.regNo,
    detail: { payment_row: String(row.id), amount_paise: row.amount_paise } });
  // This purchase's buyer, as entered — the invoice reads it from here.
  await db.query(
    `UPDATE payments SET raw = COALESCE(raw,'{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [row.id, JSON.stringify({ buyer_name: buyerName, buyer_state_code: buyerState })]);

  res.json({ ok: true, pay_path: `/pay/${row.checkout_token}`,
             pay_url: base ? `${base}/pay/${row.checkout_token}` : null,
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

  if (!row) {
    return res.status(404).json({ error: 'not_found', message: 'That document is not available.' });
  }
  if (mustBeValid && (!row.valid_until || new Date(row.valid_until) <= new Date())) {
    return res.status(410).json({ error: 'expired',
      message: 'The download period for this report has ended. Check the vehicle again for a fresh one.' });
  }
  /* The customer's own document, rebuilt from its row if the file has gone (pay/rebuild.js). */
  row.pdf_path = await require('../pay/rebuild').ensureFile(table, req.params.id);
  await activity.record(req, {
    action: `${req.query.download === '1' ? 'download' : 'view'}_${table === 'invoices' ? 'invoice' : 'report'}`,
    detail: { number: row.number } });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${row.number}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(row.pdf_path).pipe(res);
});

router.get('/reports/:id/file', sendPdf({ table: 'vehicle_reports', column: 'report_number', mustBeValid: true }));
router.get('/invoices/:id/file', sendPdf({ table: 'invoices', column: 'invoice_number' }));

module.exports = router;
