/**
 * src/vehicle/gateway.js
 * ---------------------------------------------------------------------------
 * Where vehicle data comes from — one module, two possible answers.
 *
 * ULIP authorises by SOURCE IP, so only the deployed server may call it. That
 * makes local development awkward: the bot has to run somewhere, but the data
 * only exists on one machine.
 *
 * The resolution is this module: every lookup is an HTTP call to the gateway's
 * own public API, authenticated with VEHICLE_LOOKUP_KEY. On a laptop that URL
 * is https://api.gaadipe.in; on the server it is http://localhost:5007, which
 * is the same process answering itself.
 *
 * A loopback hop costs about a millisecond and buys one code path instead of
 * two. The alternative — a second in-process route into the ULIP modules —
 * would be a copy of routes/vehicle.js that drifts out of step with it, and the
 * drift would only ever show up in production.
 * ---------------------------------------------------------------------------
 */

const { config } = require('../config');

/** One call to the deployed gateway. Never throws on a 404 — that is an answer. */
async function fetchRemote(path) {
  const url = `${config.gateway.baseUrl}${path}`;
  const started = Date.now();

  let res;
  try {
    res = await fetch(url, {
      headers: { 'x-api-key': config.gateway.apiKey },
      signal: AbortSignal.timeout(config.gateway.timeoutMs),
    });
  } catch (e) {
    // A timeout or DNS failure is not "vehicle not found" — saying so would
    // tell a paying customer their vehicle does not exist because our server
    // was slow.
    const reason = e.name === 'TimeoutError' ? 'gateway_timeout' : 'gateway_unreachable';
    console.error(`[gateway] ${reason}: ${url} (${e.message})`);
    return { success: false, error: reason, message: 'Vehicle service is temporarily unavailable.' };
  }

  const body = await res.json().catch(() => ({}));
  const ms = Date.now() - started;
  if (ms > 4000) console.warn(`[gateway] slow ${ms}ms ${path}`);

  if (res.status === 401) {
    console.error('[gateway] 401 — VEHICLE_LOOKUP_KEY does not match the server');
    return { success: false, error: 'gateway_unauthorized', message: 'Vehicle service is misconfigured.' };
  }
  return body;
}

const q = (params = {}) => {
  const s = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return s ? `?${s}` : '';
};

/* --------------------------------------------------------------- the four */

const at = (regNo, suffix, opts) =>
  fetchRemote(`/api/v1/vehicle/${encodeURIComponent(regNo)}${suffix}${q(opts)}`);

/** Everything we hold on a vehicle: RC, challan summary, FASTag. */
const full = (regNo, opts = {}) => at(regNo, '', opts);
const rc = (regNo, opts = {}) => at(regNo, '/rc', opts);
const challans = (regNo, opts = {}) => at(regNo, '/challans', opts);
const fastag = (regNo, opts = {}) => at(regNo, '/fastag', opts);

/** Is the deployed gateway reachable and is our key accepted? */
async function health() {
  const body = await fetchRemote('/api/v1/health');
  return { ...body, base_url: config.gateway.baseUrl };
}

module.exports = { full, rc, challans, fastag, health };
