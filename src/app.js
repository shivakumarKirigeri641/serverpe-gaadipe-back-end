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
const whatsappRoutes = require('./routes/whatsapp');

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

/* ------------------------------------------------------------------ public */
// Legal pages the website reads. No API key: Meta checks the privacy-policy
// URL during app review, and the path matches what the deployed front-end
// already calls.
app.use('/serverpe/platform/gaadipe/v1/public/users', publicRoutes);

// Meta's webhook, on the same public prefix as the policies — the shape the
// other ServerPe products already use. No API key: the caller is Meta, and it
// authenticates itself by signing the body with the app secret.
app.use('/serverpe/platform/gaadipe/v1/public/users', whatsappRoutes);

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

app.listen(config.port, () => {
  console.log(`GaadiPe vehicle gateway listening on http://localhost:${config.port}`);
  console.log(`  ULIP: ${config.ulip.baseUrl}  (primary VAHAN/${config.ulip.vahanPrimary})`);
  console.log(`  cache: ${config.cache.enabled ? `rc ${config.cache.rcMinutes}m · challan ${config.cache.challanMinutes}m · fastag ${config.cache.fastagMinutes}m` : 'disabled'}`);
  console.log(`  api keys configured: ${config.apiKeys.length}`);
  if (config.whatsapp.phoneNumberId) {
    console.log(`  whatsapp: +${config.whatsapp.ownNumber} id ${config.whatsapp.phoneNumberId}`
      + `  signature ${config.whatsapp.appSecret ? 'enforced' : 'OFF'}`
      + `  replies ${config.whatsapp.replyEnabled ? 'ON' : 'off (record only)'}`);
  }
});
