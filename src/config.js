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
    // Receive and record, but never reply. The flow is not built yet, and a
    // half-built bot answering real customers is worse than a silent one.
    replyEnabled: bool(process.env.WHATSAPP_REPLY_ENABLED, false),
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

  if (problems.length) throw new Error(`Configuration problems:\n  - ${problems.join('\n  - ')}`);
}

module.exports = { config, validate };
