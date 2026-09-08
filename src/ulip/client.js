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

const state = { token: null, obtainedAt: 0, inflight: null };

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
    const hint = (res.status === 412 || res.status === 403)
      ? ' — ULIP is IP-whitelisted; this host is probably not on their allow-list'
      : '';
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
