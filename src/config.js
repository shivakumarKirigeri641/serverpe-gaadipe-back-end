/**
 * src/config.js
 * ---------------------------------------------------------------------------
 * Every environment variable is read here, once, and validated at boot.
 *
 * Nothing else in the codebase touches process.env, so "what does this service
 * need to run?" is answered by reading one file — and a missing value fails
 * loudly at startup instead of at 2am inside a request.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const int = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));

const config = {
  env: String(process.env.NODE_ENV || 'development').toLowerCase(),
  port: int(process.env.PORT, 5007),

  /** Callers authenticate with x-api-key (or Authorization: Bearer). */
  apiKeys: String(process.env.VEHICLE_LOOKUP_KEY || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  db: {
    host: process.env.PGHOST || 'localhost',
    port: int(process.env.PGPORT, 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'serverpe_gaadipe',
    max: int(process.env.PGPOOL_MAX, 10),
    idleTimeoutMillis: int(process.env.PG_IDLE_MS, 30_000),
  },

  ulip: {
    baseUrl: (process.env.ULIP_BASE_URL || 'https://www.ulip.dpiit.gov.in/ulip/v1.0.0').replace(/\/+$/, ''),
    username: process.env.ULIP_USERNAME || '',
    password: process.env.ULIP_PASSWORD || '',
    timeoutMs: int(process.env.ULIP_TIMEOUT_MS, 30_000),
    // ULIP's token idles out at ~30 minutes. Refresh well before that: a
    // proactive re-login costs one request, a reactive one costs a failed
    // lookup that a customer is watching.
    tokenTtlMs: int(process.env.ULIP_TOKEN_TTL_MS, 25 * 60 * 1000),
    // Set to '01' when ULIP's JSON adapter (VAHAN/04) is broken for every
    // number, to skip the wasted round-trip and go straight to the XML feed.
    vahanPrimary: String(process.env.ULIP_VAHAN_PRIMARY || '04'),
  },

  /**
   * In-memory cache. Deliberately not a database: this service is a thin
   * gateway that should deploy with `npm install && pm2 start`, and the
   * calling app owns persistence.
   *
   * Lifetimes reflect how fast each dataset actually moves. Challans are the
   * volatile one and the reason anyone pays; RC and FASTag barely change.
   */
  cache: {
    enabled: bool(process.env.CACHE_ENABLED, true),
    rcMinutes: int(process.env.CACHE_MINUTES_RC, 60 * 24 * 7),
    challanMinutes: int(process.env.CACHE_MINUTES_CHALLAN, 60 * 12),
    fastagMinutes: int(process.env.CACHE_MINUTES_FASTAG, 60 * 24 * 7),
    // A vehicle ULIP says does not exist. Cached so a mistyped plate costs one
    // call rather than one per attempt — the free-check funnel is exactly where
    // strangers type nonsense.
    notFoundMinutes: int(process.env.CACHE_MINUTES_NOT_FOUND, 60 * 24),
    maxEntries: int(process.env.CACHE_MAX_ENTRIES, 5000),
  },

  /**
   * Where vehicle data is fetched from.
   *
   * ULIP authorises by SOURCE IP, so only the deployed server may call it. The
   * bot therefore never calls ULIP directly — it calls this gateway's own
   * public API. On a laptop that is https://api.gaadipe.in; on the server it is
   * http://localhost:PORT, the same process answering itself for the cost of a
   * millisecond and one code path instead of two.
   */
  gateway: {
    baseUrl: (process.env.GATEWAY_BASE_URL
      || `http://localhost:${int(process.env.PORT, 5007)}`).replace(/\/+$/, ''),
    apiKey: String(process.env.VEHICLE_LOOKUP_KEY || '').split(',')[0].trim(),
    timeoutMs: int(process.env.GATEWAY_TIMEOUT_MS, 35_000),
  },

  /**
   * WhatsApp Cloud API. The number shares a WhatsApp Business Account with
   * QuizPe, so both products' events are delivered to whichever apps are
   * subscribed — every handler must check phoneNumberId before acting, or
   * GaadiPe would answer QuizPe's parents.
   */
  whatsapp: {
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    token: process.env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    businessId: process.env.WHATSAPP_BUSINESS_ID || '',
    appId: process.env.WHATSAPP_APP_ID || '',
    // Meta signs every webhook body with this. Blank means signature checking
    // is off — acceptable while developing behind ngrok, never in production.
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    // Echoed back during Meta's one-time subscribe handshake.
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    // Our own number, so we can recognise it in a payload.
    ownNumber: String(process.env.WHATSAPP_BUSINESS_PHONENUMBER || ''),
    /*
     * IS WHATSAPP OFFERED TO CUSTOMERS? (user, 2026-09-22)
     *
     * GaadiPe has no WhatsApp Business number of its own yet, so GaadiPe is
     * web-only and every "Open WhatsApp" shown to a customer points at a number
     * that will not answer. This hides those doors; it closes nothing — the bot,
     * the webhook and the sending code are untouched, and WHATSAPP_ENABLED=1
     * brings the links back the day the number arrives.
     *
     * The site has the same switch of its own (VITE_WHATSAPP_ENABLED).
     */
    enabled: String(process.env.WHATSAPP_ENABLED || '') === '1',
    // Receive and record, but never reply. The flow is not built yet, and a
    // half-built bot answering real customers is worse than a silent one.
    replyEnabled: bool(process.env.WHATSAPP_REPLY_ENABLED, false),
    // TESTING GUARD. When set, GaadiPe talks ONLY to these numbers — replies,
    // alerts, receipts, everything. Anyone else's messages are still recorded,
    // but never answered and never moved through the flow. Empty means everyone.
    // Comma-separated; 9886122415 and 919886122415 are the same number.
    // (Both spellings accepted: RECEPIENTS is what the .env was written with.)
    allowedRecipients: String(process.env.WHATSAPP_ALLOWED_RECIPIENTS
      || process.env.WHATSAPP_ALLOWED_RECEPIENTS || '')
      .split(',').map(s => s.replace(/\D/g, '').slice(-10)).filter(s => s.length === 10),
  },

  /**
   * The admin panel, which is a separate front-end on its own origin.
   *
   * devOtp is a FIXED sign-in code for building against — signing in must not
   * depend on a message arriving. It is a back door by definition, so it is
   * empty in production and validate() refuses to boot if one is forced there.
   */
  admin: {
    // The panel passcode: 6416 while building; production signs in by passcode
    // only if ADMIN_PASSCODE is set, never by a default.
    passcode: String(process.env.ADMIN_PASSCODE
      || (String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? '' : '6416')),
    devOtp: String(process.env.NODE_ENV || '').toLowerCase() === 'production'
      ? ''
      : String(process.env.ADMIN_DEV_OTP || '1234'),
    // Browsers only send the panel's requests if this server names its origin.
    origins: String(process.env.ADMIN_ORIGINS
      || 'http://localhost:5173,http://localhost:4173')
      .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean),
  },

  /**
   * gaadipe.in — the customer's own account on the website.
   *
   * Same reasoning as the admin panel's devOtp: a fixed code so the sign-in
   * flow can be built before an SMS account exists, and never in production.
   */
  site: {
    // THE OWNER'S OWN SIGN-IN (user, 2026-09-21): the mobile of an active
    // owner in admin_users signs in to the site with this fixed code and no SMS
    // is sent — in production too. Nobody else is affected.
    ownerOtp: String(process.env.SITE_OWNER_OTP || '641641').replace(/\D/g, ''),
    devOtp: String(process.env.NODE_ENV || '').toLowerCase() === 'production'
      ? ''
      : String(process.env.SITE_DEV_OTP || '1234'),
    origins: String(process.env.SITE_ORIGINS
      || 'http://localhost:5174,http://localhost:4174,https://gaadipe.in,https://www.gaadipe.in')
      .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean),
  },

  logCalls: bool(process.env.LOG_ULIP_CALLS, true),
};

function validate() {
  const problems = [];
  if (!config.db.database) problems.push('PGDATABASE is required');
  if (!config.ulip.username) problems.push('ULIP_USERNAME is required');
  if (!config.ulip.password) problems.push('ULIP_PASSWORD is required');
  if (!config.apiKeys.length) problems.push('VEHICLE_LOOKUP_KEY is required (callers authenticate with it)');
  if (config.apiKeys.some(k => k.length < 16)) problems.push('VEHICLE_LOOKUP_KEY should be at least 16 characters');
  // WhatsApp is optional: the gateway must still boot on a machine that only
  // does vehicle lookups. But a half-configured webhook is a trap, so if any
  // WhatsApp value is present, demand the ones that make it safe.
  const wa = config.whatsapp;
  if (wa.token || wa.phoneNumberId) {
    if (!wa.phoneNumberId) problems.push('WHATSAPP_PHONE_NUMBER_ID is required when WhatsApp is configured');
    if (!wa.token) problems.push('WHATSAPP_ACCESS_TOKEN is required when WhatsApp is configured');
    if (!wa.verifyToken) problems.push('WHATSAPP_VERIFY_TOKEN is required — Meta will not subscribe without it');
    if (config.env === 'production' && !wa.appSecret) {
      problems.push('WHATSAPP_APP_SECRET is required in production — without it any caller can post fake messages');
    }
  }

  // A fixed admin code on a live panel would hand every customer's details to
  // anyone who guessed an admin's mobile number.
  if (config.env === 'production' && process.env.ADMIN_DEV_OTP) {
    problems.push('ADMIN_DEV_OTP must not be set in production — remove it before deploying');
  }
  if (config.env === 'production' && process.env.SITE_DEV_OTP) {
    problems.push('SITE_DEV_OTP must not be set in production — remove it before deploying');
  }
  // A live site whose customers cannot receive a code cannot sign anyone in,
  // and the failure would only show up as customers quietly giving up.
  if (config.env === 'production' && !process.env.SMS_PROVIDER) {
    problems.push('SMS_PROVIDER is required in production — site sign-in sends the code by SMS');
  }

  if (problems.length) throw new Error(`Configuration problems:\n  - ${problems.join('\n  - ')}`);
}

module.exports = { config, validate };
