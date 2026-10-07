/**
 * src/ulip/client.js
 * ---------------------------------------------------------------------------
 * The only place that talks to ULIP.
 *
 * AUTHENTICATION is automatic. Callers never see a token: this module logs in
 * with the username and password from .env, caches the bearer token, refreshes
 * it before ULIP's ~30-minute idle timeout, and re-logins once if a call is
 * rejected. Concurrent callers share a single in-flight login rather than
 * stampeding the auth endpoint.
 *
 * THE IMPORTANT PART is `classify()`. ULIP reports a missing vehicle as a
 * complete success at every outer level:
 *
 *   HTTP 200, error:"false", code:"200", message:"Success"
 *     └ response[0].responseStatus = "ERROR"
 *         └ message.code = "231", text = "Vehicle Details not Found"
 *
 * So the difference between "this vehicle does not exist" and "ULIP hiccupped,
 * try again" lives entirely in the innermost object. Getting it wrong is
 * expensive in both directions: treat a genuine miss as retryable and every
 * mistyped plate costs two API calls forever; treat a hiccup as a miss and a
 * customer is told their own vehicle does not exist.
 * ---------------------------------------------------------------------------
 */

const { config } = require('../config');

const state = {
  token: null, obtainedAt: 0, inflight: null, lockedUntil: 0, lockedWhy: null,
  refusals: 0,          // refused logins in a row; each one doubles the pause
  attempts: [],         // when each login was tried (the hourly budget)
  restored: false,      // the saved pause has been read back after a restart
  limitUntil: 0, limitHitAt: 0, limitSaid: null,   // ULIP's daily API limit (see hitDailyLimit)
};

/*
 * A LOCKED ACCOUNT IS LEFT ALONE (2026-10-05). ULIP answered the login with
 * 403 "Account is Locked". Every lookup used to log in again — about three
 * failed logins per customer check, plus the watchdog and the waiting list —
 * and repeated failed logins are what keeps an account locked. Now a refused
 * login (locked / forbidden / precondition failed) stops all logins for
 * ULIP_LOGIN_PAUSE_MINUTES (30): lookups fail at once with "ULIP login failed",
 * so they go straight to eChallan.app and the RC backup, and the admin is told
 * once. The first login after the pause tries again.
 *
 * NEVER LOCK AGAIN (user, 2026-10-05: "please do not lock again"):
 *   - each refusal in a row doubles the pause: 30 → 60 → 120 … up to 6 hours
 *   - at most ULIP_LOGIN_MAX_PER_HOUR (6) login tries in any hour, whatever the
 *     reason; past that, lookups skip ULIP without asking it
 *   - the pause is saved (app_settings ulip_login_paused_until), so a restart
 *     or a deploy does not try again before it ends
 *   - ULIP_LOGIN_OFF=1 in .env stops every ULIP login outright
 */
const BASE_PAUSE_MIN = () => Number(process.env.ULIP_LOGIN_PAUSE_MINUTES) || 30;
const MAX_PAUSE_MIN = 360;
const MAX_PER_HOUR = () => Number(process.env.ULIP_LOGIN_MAX_PER_HOUR) || 6;
const loginsOff = () => /^(1|true|yes|on)$/i.test(String(process.env.ULIP_LOGIN_OFF || ''));

function savePause() {
  try {
    require('../db').query(
      `INSERT INTO app_settings (key, value) VALUES ('ulip_login_paused_until', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`,
      [JSON.stringify({ until: state.lockedUntil, why: state.lockedWhy, refusals: state.refusals })]).catch(() => {});
  } catch { /* saving is a nicety; the pause in memory still holds */ }
}

/** After a restart, the pause that was running before it (read once). */
async function restorePause() {
  if (state.restored) return;
  state.restored = true;
  try {
    const row = await require('../db').one(`SELECT value FROM app_settings WHERE key = 'ulip_login_paused_until'`);
    const saved = row?.value ? JSON.parse(row.value) : null;
    // The count of refusals carries over even after the pause ended, so the next refusal pauses longer.
    if (saved) state.refusals = Math.max(state.refusals, Number(saved.refusals) || 0);
    if (saved && Number(saved.until) > Date.now() && Number(saved.until) > state.lockedUntil) {
      state.lockedUntil = Number(saved.until);
      state.lockedWhy = saved.why || 'refused before the restart';
      console.warn('[ulip] login pause carried over the restart: %d more min', Math.ceil((state.lockedUntil - Date.now()) / 60000));
    }
  } catch { /* no saved pause — carry on */ }
  try {
    const row = await require('../db').one(`SELECT value FROM app_settings WHERE key = 'ulip_daily_limit'`);
    const saved = row?.value ? JSON.parse(row.value) : null;
    if (saved) {
      state.limitHitAt = Math.max(state.limitHitAt, Number(saved.hitAt) || 0);
      if (Number(saved.until) > Date.now() && Number(saved.until) > state.limitUntil) {
        state.limitUntil = Number(saved.until);
        state.limitSaid = saved.said || null;
        console.warn('[ulip] daily-limit pause carried over the restart: until %s', istTime(state.limitUntil));
      }
    }
  } catch { /* no saved limit — carry on */ }
}

/*
 * ULIP'S DAILY API LIMIT (2026-10-07). ULIP answered VAHAN/04 with
 * code "NO_DATA_FOUND" and the message "Daily API limit exceeded for your
 * account. Please contact the administrator." — logged only as a retry, so it
 * looked like VAHAN being down, and every customer check, the watchdog and the
 * waiting list kept asking (each one counting against the same limit).
 * Now a "limit exceeded" answer, in whatever field ULIP puts it, stops every
 * ULIP call until midnight IST: lookups fail at once with code DAILY_LIMIT and
 * go to eChallan.app and the RC backup, and the admin is told once. If the
 * limit is hit again within a day of the last time (a rolling 24 hours, not a
 * midnight reset), the next try is an hour later instead. The pause is saved
 * (app_settings ulip_daily_limit), so a restart does not ask again; deleting
 * that row ends it.
 */
const LIMIT_RE = /limit\s+exceeded/i;
const IST_MS = 5.5 * 3600e3;
const istTime = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 16).replace('T', ' ');
function nextIstMidnight(now = Date.now()) {
  const d = new Date(now + IST_MS);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime() - IST_MS;
}

function hitDailyLimit(said) {
  const now = Date.now();
  if (now < state.limitUntil) return;            // already paused (calls that were in flight)
  const again = state.limitHitAt && now - state.limitHitAt < 24 * 3600e3;
  state.limitUntil = again ? now + 3600e3 : nextIstMidnight(now);
  state.limitHitAt = now;
  state.limitSaid = String(said || 'Daily API limit exceeded').slice(0, 160);
  try {
    require('../db').query(
      `INSERT INTO app_settings (key, value) VALUES ('ulip_daily_limit', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`,
      [JSON.stringify({ until: state.limitUntil, hitAt: state.limitHitAt, said: state.limitSaid })]).catch(() => {});
  } catch { /* the pause in memory still holds */ }
  console.error('[ulip] daily API limit reached ("%s") — no ULIP calls until %s IST', state.limitSaid, istTime(state.limitUntil));
  if (again) return;                             // told once per day, not every hour
  try {
    require('../util/adminPing').ping({
      key: 'ulip_daily_limit', severity: 'warning', source: 'vehicle_api',
      title: '⏳ ULIP daily limit reached',
      text: `ULIP said: "${state.limitSaid}". GaadiPe has stopped calling ULIP until ${istTime(state.limitUntil)} IST `
        + 'and is using eChallan.app and the RC backup meanwhile. Ask ULIP support for the daily limit and a higher one.',
    }).catch(() => {});
  } catch { /* the ping is never worth a failure here */ }
}

function pauseLogins(why) {
  const first = Date.now() >= state.lockedUntil;
  state.refusals += 1;
  const mins = Math.min(BASE_PAUSE_MIN() * 2 ** (state.refusals - 1), MAX_PAUSE_MIN);
  state.lockedUntil = Date.now() + mins * 60000;
  state.lockedWhy = why;
  state.token = null;
  savePause();
  if (!first) return;
  console.error('[ulip] login refused (%s, %d in a row) — no ULIP logins for %d min', why, state.refusals, mins);
  try {
    require('../util/adminPing').ping({
      key: 'ulip_login_refused', severity: 'critical', source: 'vehicle_api',
      title: /lock/i.test(why) ? '🔒 ULIP account is LOCKED' : '🔒 ULIP refused the login',
      text: `ULIP said: "${why}". GaadiPe has stopped logging in to ULIP for ${mins} minutes `
        + '(repeated failed logins keep an account locked) and is using eChallan.app and the RC backup meanwhile. '
        + 'Ask ULIP support to unlock the account; it retries by itself after the pause.',
    }).catch(() => {});
  } catch { /* the ping is never worth a failure here */ }
}

/* ULIP's documented per-dataset "no record" codes. These END a lookup — no
   fallback, no retry, because no other dataset will find the vehicle either. */
const NOT_FOUND_CODES = new Set([
  '231',   // VAHAN   — "Vehicle Details not Found"
  '305',   // ECHALLAN — "No Records Found!"
  '740',   // FASTAG  — no tag issued for this vehicle
]);

/** Outcome of one ULIP call, independent of HTTP status. */
const OUTCOME = { FOUND: 'FOUND', NOT_FOUND: 'NOT_FOUND', RETRY: 'RETRY', REJECTED: 'REJECTED' };

async function login() {
  const res = await fetch(`${config.ulip.baseUrl}/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: config.ulip.username, password: config.ulip.password }),
    signal: AbortSignal.timeout(config.ulip.timeoutMs),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON means a proxy or WAF answered, not ULIP */ }

  const token = body?.response?.id;
  if (!token) {
    // 412/403 with "Access denied" is ULIP's IP-whitelist rejection — the usual
    // cause when this works on the server and not on a laptop.
    const locked = /locked/i.test(String(body?.message || text));
    const hint = locked ? ' — the ULIP account is locked'
      : (res.status === 412 || res.status === 403)
        ? ' — ULIP is IP-whitelisted; this host is probably not on their allow-list'
        : '';
    if (locked || res.status === 403 || res.status === 412 || res.status === 401) {
      pauseLogins(String(body?.message || `HTTP ${res.status}`).slice(0, 120));
    }
    throw new Error(`ULIP login failed: HTTP ${res.status}${hint}. ${text.slice(0, 200)}`);
  }
  state.token = token;
  state.obtainedAt = Date.now();
  if (state.refusals) { state.refusals = 0; savePause(); }
  console.log('[ulip] logged in, token cached');
  return token;
}

/** Cached token; concurrent callers share one in-flight login. */
async function getToken({ force = false } = {}) {
  const fresh = state.token && (Date.now() - state.obtainedAt) < config.ulip.tokenTtlMs;
  if (fresh && !force) return state.token;
  if (state.inflight) return state.inflight;
  // Every guard below fails at once, without asking ULIP (see pauseLogins).
  if (loginsOff()) throw new Error('ULIP login failed: switched off (ULIP_LOGIN_OFF)');
  await restorePause();
  if (Date.now() < state.lockedUntil) {
    const mins = Math.ceil((state.lockedUntil - Date.now()) / 60000);
    throw new Error(`ULIP login failed: paused for ${mins} more min after "${state.lockedWhy}" (not retried, to let the account unlock)`);
  }
  const hourAgo = Date.now() - 3600e3;
  state.attempts = state.attempts.filter((t) => t > hourAgo);
  if (state.attempts.length >= MAX_PER_HOUR()) {
    throw new Error(`ULIP login failed: ${state.attempts.length} login tries in the last hour (limit ${MAX_PER_HOUR()}), skipped to protect the account`);
  }
  if (state.inflight) return state.inflight;      // another caller started one while we waited
  state.attempts.push(Date.now());
  state.inflight = login().finally(() => { state.inflight = null; });
  return state.inflight;
}

/**
 * Turn a ULIP response into an outcome the rest of the code can act on.
 * Never throws — a missing vehicle is an answer, not an exception.
 */
function classify(httpStatus, body) {
  if (httpStatus === 400) {
    return { outcome: OUTCOME.REJECTED, code: '400', message: body?.message || 'Bad request', payload: null };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { outcome: OUTCOME.RETRY, code: String(httpStatus), message: 'Unauthenticated', payload: null };
  }
  if (httpStatus >= 500) {
    return { outcome: OUTCOME.RETRY, code: String(httpStatus), message: 'ULIP or upstream unavailable', payload: null };
  }

  // NOTE: `error` is the STRING "false" on success — `if (body.error)` is true
  // for every good response. A classic silent inversion.
  if (String(body?.error) === 'true' || String(body?.code || '') !== '200') {
    return { outcome: OUTCOME.RETRY, code: String(body?.code || 'UNKNOWN'), message: body?.message || 'ULIP rejected the request', payload: null };
  }

  const entry = Array.isArray(body?.response) ? body.response[0] : body?.response;
  if (!entry) return { outcome: OUTCOME.RETRY, code: 'EMPTY', message: 'No response body', payload: null };

  // Dataset-level failure hiding inside a successful envelope.
  if (String(entry.responseStatus || '').toUpperCase() === 'ERROR') {
    const inner = entry.message || {};
    const code = String(inner.code ?? '');
    const text = inner.text || 'Dataset reported an error';
    return {
      outcome: NOT_FOUND_CODES.has(code) ? OUTCOME.NOT_FOUND : OUTCOME.RETRY,
      code: code || 'DATASET_ERROR', message: text, payload: null,
    };
  }

  return { outcome: OUTCOME.FOUND, code: '200', message: null, payload: entry.response };
}

/**
 * POST to a ULIP dataset.
 * Returns { outcome, code, message, payload, httpStatus, durationMs, path }.
 * The 401 retry counts as ONE logical call, so the cost figures stay honest.
 */
async function post(path, body) {
  const started = Date.now();
  const url = `${config.ulip.baseUrl}/${String(path).replace(/^\/+/, '')}`;

  const send = async (token) => fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.ulip.timeoutMs),
  });

  await restorePause();
  if (Date.now() < state.limitUntil) {
    return { outcome: OUTCOME.RETRY, code: 'DAILY_LIMIT',
             message: `ULIP daily API limit reached ("${state.limitSaid}"), not asked again until ${istTime(state.limitUntil)} IST`,
             payload: null, httpStatus: null, durationMs: 0, path };
  }

  try {
    let token = await getToken();
    let res = await send(token);

    if (res.status === 401 || res.status === 403) {
      token = await getToken({ force: true });     // expired mid-flight
      res = await send(token);
    }

    const text = await res.text();
    const durationMs = Date.now() - started;

    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* handled below */ }
    if (!parsed) {
      return { outcome: OUTCOME.RETRY, code: 'BAD_JSON', message: text.slice(0, 200), payload: null, httpStatus: res.status, durationMs, path };
    }

    let verdict = classify(res.status, parsed);
    // The limit hides under any code, even a "found" whose record is the message itself.
    if (LIMIT_RE.test(text)) {
      const entry = Array.isArray(parsed?.response) ? parsed.response[0] : parsed?.response;
      const said = [parsed?.message, entry?.message?.text, typeof verdict.payload === 'string' ? verdict.payload : null]
        .find((s) => LIMIT_RE.test(String(s || ''))) || 'Daily API limit exceeded';
      verdict = { outcome: OUTCOME.RETRY, code: 'DAILY_LIMIT', message: String(said), payload: null };
      hitDailyLimit(said);
    }
    if (config.logCalls) {
      console.log(`[ulip] ${path.padEnd(12)} ${String(res.status).padEnd(3)} ${String(durationMs).padStart(5)}ms  ${verdict.outcome}${verdict.code && verdict.code !== '200' ? ' (' + verdict.code + ')' : ''}`
        + (verdict.outcome === OUTCOME.RETRY && verdict.message ? ` — ${String(verdict.message).slice(0, 100)}` : ''));
    }
    return { ...verdict, httpStatus: res.status, durationMs, path, raw: parsed };
  } catch (e) {
    const durationMs = Date.now() - started;
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    if (config.logCalls) console.warn(`[ulip] ${path} ${timedOut ? 'TIMEOUT' : 'TRANSPORT'} after ${durationMs}ms: ${e.message}`);
    return {
      outcome: OUTCOME.RETRY,
      code: timedOut ? 'TIMEOUT' : 'TRANSPORT',
      message: e.message, payload: null, httpStatus: null, durationMs, path,
    };
  }
}

module.exports = { post, getToken, classify, OUTCOME, NOT_FOUND_CODES };
