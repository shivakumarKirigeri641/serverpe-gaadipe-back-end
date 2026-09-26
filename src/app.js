/**
 * src/app.js
 * ---------------------------------------------------------------------------
 * GaadiPe vehicle gateway.
 *
 * WHY THIS SERVICE EXISTS: ULIP authorises by source IP, so only this deployed,
 * whitelisted server can call VAHAN / ECHALLAN / FASTAG. Every other ServerPe
 * app — the local development machine included — calls this instead, with an
 * API key, from anywhere.
 *
 *   GET /api/v1/vehicle/:regNo             everything (cache-first)
 *   GET /api/v1/vehicle/:regNo?refresh=1   force a fresh ULIP fetch
 *   GET /api/v1/vehicle/:regNo/rc          RC only
 *   GET /api/v1/vehicle/:regNo/challans    challans only
 *   GET /api/v1/vehicle/:regNo/fastag      FASTag only
 *   GET /api/v1/health                     liveness (also key-protected)
 *
 *   GET/POST /serverpe/platform/gaadipe/v1/public/users/whatsapp/webhook
 *                                          Meta's webhook (signature-checked)
 *
 * Auth: x-api-key: <VEHICLE_LOOKUP_KEY>   or   Authorization: Bearer <key>
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const { config, validate } = require('./config');
const cache = require('./util/cache');
const vehicleRoutes = require('./routes/vehicle');
const publicRoutes = require('./routes/public');
const watchJob = require('./jobs/watch');
const reconcileJob = require('./jobs/reconcile');
const whatsappRoutes = require('./routes/whatsapp');
const paymentRoutes = require('./routes/payments');
const checkoutRoutes = require('./routes/checkout');
const adminRoutes = require('./routes/adminApi');
const siteRoutes = require('./routes/siteApi');

validate();   // fail at boot, not mid-request

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);        // behind nginx: req.ip is the real client
// rawBody is kept because Meta signs the EXACT bytes of a webhook body —
// re-serialised JSON produces a different HMAC and every request would look
// forged. Cheap: a reference to a buffer express already had.
app.use(express.json({
  limit: '256kb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

/* ------------------------------------------------------------------- admin */
/**
 * The admin panel is a separate front-end on its own origin, so the browser
 * will not send its requests unless this server names that origin. Only the
 * origins in ADMIN_ORIGINS are answered — a wildcard here would let any website
 * a signed-in admin happens to visit call this API with their session.
 */
const cors = (allowedOrigins) => (req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Refresh, X-GP-K, X-GP-D');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};

/* Every JSON call to the panel and the site goes through the same chain (user,
   2026-09-18): refused IPs, automation tools and the per-IP rate first; then the
   encrypted envelope is opened; then the same-call-in-a-loop check; then the
   routes. PDF downloads stay plain — they are files, not JSON. */
const { gate, loopGuard } = require('./security/guard');
const { tunnel } = require('./security/tunnel');
// Files come back as files, not through the encrypted tunnel: report and
// invoice PDFs, the backup, and the CSV exports (command center phase 3).
const fileRoute = (req) => /^\/((reports|invoices)\/[^/]+\/file|maintenance\/backup|export\/[a-z_]+(\.csv)?|exports\/\d+\/file)$/.test(req.path);

app.use('/admin/api', cors(config.admin.origins), gate('admin'), tunnel('admin', { exempt: fileRoute }),
  loopGuard('admin'), adminRoutes);

/* ------------------------------------------------------------- the website */
// gaadipe.in, where a customer signs in with their own number to see their
// vehicles, reports and invoices. Same data as WhatsApp, second door.
app.use('/site/api', cors(config.site.origins), gate('site'), tunnel('site', { exempt: fileRoute }),
  loopGuard('site'), siteRoutes);

/* ------------------------------------------------------------------ public */
// Legal pages the website reads. No API key: Meta checks the privacy-policy
// URL during app review, and the path matches what the deployed front-end
// already calls.
//
// CORS IS OPEN HERE, and only here. This is published legal text — the terms a
// customer agreed to, the privacy policy Meta reviews — and it is meant to be
// readable by any page that wants to show it. The browser was refusing to let
// gaadipe.in read its own terms until this was added.
app.use('/serverpe/platform/gaadipe/v1/public/users', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/serverpe/platform/gaadipe/v1/public/users', publicRoutes);
// Website events for the command center: anonymous, narrow, rate-limited.
app.use('/serverpe/platform/gaadipe/v1/public/users', require('./routes/track'));

// Meta's webhook, on the same public prefix as the policies — the shape the
// other ServerPe products already use. No API key: the caller is Meta, and it
// authenticates itself by signing the body with the app secret.
app.use('/serverpe/platform/gaadipe/v1/public/users', whatsappRoutes);

// Razorpay's webhook. Also unauthenticated, and for the same reason: the caller
// is Razorpay, and it proves itself by signing the body with the webhook secret.
app.use('/serverpe/platform/gaadipe/v1/public/users', paymentRoutes);

// The hosted checkout page, at /pay/<token>. Public by design: the token IS the
// authorisation, it belongs to exactly one payment, and it grants nothing
// except the right to pay that one amount.
app.use('/', checkoutRoutes);

// The confirm and unsubscribe links in customer email. The token is the authorisation.
app.use('/', require('./routes/email'));

/* -------------------------------------------------------------------- auth */
/** Constant-time compare, so a wrong key cannot be found by timing. */
function keyMatches(given) {
  const crypto = require('crypto');
  const a = Buffer.from(String(given));
  return config.apiKeys.some((k) => {
    const b = Buffer.from(k);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

app.use('/api/v1', (req, res, next) => {
  const header = req.get('x-api-key')
    || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!header || !keyMatches(header)) {
    return res.status(401).json({ success: false, error: 'unauthorized',
      message: 'Provide a valid x-api-key header.' });
  }
  next();
});

/* ------------------------------------------------------------------ routes */
app.get('/api/v1/health', (_req, res) => res.json({
  success: true,
  service: 'gaadipe-vehicle-gateway',
  env: config.env,
  uptime_seconds: Math.round(process.uptime()),
  cache: cache.stats(),
}));

app.use('/api/v1', vehicleRoutes);

app.use((req, res) => res.status(404).json({ success: false, error: 'not_found', path: req.path }));

// Last-resort handler: never leak a stack trace to a caller.
app.use((err, _req, res, _next) => {
  console.error('[app] unhandled:', err.message);
  res.status(500).json({ success: false, error: 'server_error' });
});

/**
 * Warn — loudly, and without refusing to boot — when the code on disk expects
 * migrations the database has not had.
 *
 * Deploying new code and forgetting `npm run migrate` is the classic way a
 * release half-works: the process starts, and the first customer to reach the
 * new path hits a missing table. Refusing to boot would take the gateway and
 * the payment webhooks down over a column; saying so on line one of the log
 * does not.
 */
async function checkMigrations() {
  try {
    const fs = require('fs');
    const path = require('path');
    const db = require('./db');
    const files = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
      .filter(f => f.endsWith('.sql'));
    const { rows } = await db.query('SELECT filename FROM schema_migrations');
    const done = new Set(rows.map(r => r.filename));
    const pending = files.filter(f => !done.has(f)).sort();
    if (pending.length) {
      console.error(`  ⚠  ${pending.length} migration(s) NOT APPLIED: ${pending.join(', ')}`
        + ' — run `npm run migrate`');
    } else {
      console.log('  migrations: up to date');
    }
  } catch (e) {
    console.error('  ⚠  could not check migrations:', e.message);
  }
}

app.listen(config.port, () => {
  console.log(`GaadiPe vehicle gateway listening on http://localhost:${config.port}`);
  console.log(`  ULIP: ${config.ulip.baseUrl}  (primary VAHAN/${config.ulip.vahanPrimary})`);
  console.log(`  cache: ${config.cache.enabled ? `rc ${config.cache.rcMinutes}m · challan ${config.cache.challanMinutes}m · fastag ${config.cache.fastagMinutes}m` : 'disabled'}`);
  console.log(`  api keys configured: ${config.apiKeys.length}`);
  // The watch job only runs where WhatsApp is configured: a gateway-only
  // deployment has no one to notify.
  // The watch job sends alerts by WhatsApp template, so it needs WhatsApp set
  // up — but not the chat bot's replies: the evening alerts go out even while
  // the product is web-first.
  if (config.whatsapp.phoneNumberId) {
    watchJob.start(Number(process.env.WATCH_TICK_SECONDS) || 60);
  }
  // A webhook is a delivery attempt, not a guarantee. This is what stops a
  // captured payment from silently delivering nothing — on the website too, so
  // it runs whether or not WhatsApp is on.
  reconcileJob.start(Number(process.env.RECONCILE_TICK_SECONDS) || 60);
  // Emails to the admin: sign-ins, payments, contact messages, the day's summary.
  require('./jobs/notify').start(Number(process.env.NOTIFY_TICK_SECONDS) || 30);
  // Emails to customers: confirmations, the daily update, the free digest.
  require('./jobs/customerMail').start(Number(process.env.CUSTOMER_MAIL_TICK_SECONDS) || 60);
  // QuizPe referrals: has a referred parent bought premium? (read-only on QuizPe)
  require('./jobs/referrals').start();
  // Expiry warnings: insurance, PUC, tax, fitness and permit, for anyone who
  // paid. Hourly is plenty — a date a month away does not move.
  require('./jobs/expiryWatch').start(Number(process.env.EXPIRY_TICK_SECONDS) || 3600);
  // Three days before monitoring ends, once per subscription.
  require('./jobs/renewal').start(Number(process.env.RENEWAL_TICK_SECONDS) || 6 * 3600);
  // Broadcasts the panel has queued, a few template messages a minute.
  require('./jobs/broadcast').start(Number(process.env.BROADCAST_TICK_SECONDS) || 60);
  // The command center's alert rules (records API, WhatsApp, payments, jobs…).
  require('./jobs/alerts').start(Number(process.env.ALERTS_TICK_SECONDS) || 60);
  // Payments against Razorpay, once a day after 03:00 IST (operations module).
  require('./jobs/reconDaily').start(Number(process.env.RECON_TICK_SECONDS) || 3600);
  // Scheduled backup (when switched on) and job-history trimming (operations module).
  require('./jobs/maintenance').start(Number(process.env.MAINTENANCE_TICK_SECONDS) || 3600);
  // One free reminder inside the 24-hour window: terms not agreed, link not paid.
  require('./jobs/nudge').start(Number(process.env.NUDGE_TICK_SECONDS) || 300);


  // Page, click and action history is kept activity_retention_days, then deleted.
  const pruneActivity = () => require('./site/activity').prune().catch((e) => console.warn('[activity] prune:', e.message));
  setInterval(pruneActivity, 6 * 60 * 60 * 1000).unref();
  setTimeout(pruneActivity, 60 * 1000).unref();
  if (config.whatsapp.phoneNumberId) {
    console.log(`  whatsapp: +${config.whatsapp.ownNumber} id ${config.whatsapp.phoneNumberId}`
      + `  signature ${config.whatsapp.appSecret ? 'enforced' : 'OFF'}`
      + `  replies ${config.whatsapp.replyEnabled ? 'ON' : 'off (record only)'}`
      + (config.whatsapp.allowedRecipients.length
          ? `  TEST MODE: only ${config.whatsapp.allowedRecipients.length} allowed number(s)`
          : ''));
  }
  checkMigrations();
});
