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

const state = { token: null, obtainedAt: 0, inflight: null, lockedUntil: 0, lockedWhy: null };

/*
 * A LOCKED ACCOUNT IS LEFT ALONE (2026-10-05). ULIP answered the login with
 * 403 "Account is Locked". Every lookup used to log in again — about three
 * failed logins per customer check, plus the watchdog and the waiting list —
 * and repeated failed logins are what keeps an account locked. Now a refused
 * login (locked / forbidden / precondition failed) stops all logins for
 * ULIP_LOGIN_PAUSE_MINUTES (30): lookups fail at once with "ULIP login failed",
 * so they go straight to eChallan.app and the RC backup, and the admin is told
 * once. The first login after the pause tries again.
 */
const PAUSE_MS = () => (Number(process.env.ULIP_LOGIN_PAUSE_MINUTES) || 30) * 60000;
function pauseLogins(why) {
  const first = Date.now() >= state.lockedUntil;
  state.lockedUntil = Date.now() + PAUSE_MS();
  state.lockedWhy = why;
  state.token = null;
  if (!first) return;
  console.error('[ulip] login refused (%s) — no ULIP logins for %d min', why, PAUSE_MS() / 60000);
  try {
    require('../util/adminPing').ping({
      key: 'ulip_login_refused', severity: 'critical', source: 'vehicle_api',
      title: /lock/i.test(why) ? '🔒 ULIP account is LOCKED' : '🔒 ULIP refused the login',
      text: `ULIP said: "${why}". GaadiPe has stopped logging in to ULIP for ${PAUSE_MS() / 60000} minutes `
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
  console.log('[ulip] logged in, token cached');
  return token;
}

/** Cached token; concurrent callers share one in-flight login. */
async function getToken({ force = false } = {}) {
  const fresh = state.token && (Date.now() - state.obtainedAt) < config.ulip.tokenTtlMs;
  if (fresh && !force) return state.token;
  // Logins paused after a refusal (see pauseLogins): fail at once, without asking ULIP.
  if (Date.now() < state.lockedUntil) {
    const mins = Math.ceil((state.lockedUntil - Date.now()) / 60000);
    throw new Error(`ULIP login failed: paused for ${mins} more min after "${state.lockedWhy}" (not retried, to let the account unlock)`);
  }
  if (!state.inflight) state.inflight = login().finally(() => { state.inflight = null; });
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

    const verdict = classify(res.status, parsed);
    if (config.logCalls) {
      console.log(`[ulip] ${path.padEnd(12)} ${String(res.status).padEnd(3)} ${String(durationMs).padStart(5)}ms  ${verdict.outcome}${verdict.code && verdict.code !== '200' ? ' (' + verdict.code + ')' : ''}`);
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
