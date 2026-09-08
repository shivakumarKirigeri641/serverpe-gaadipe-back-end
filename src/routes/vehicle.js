/**
 * src/routes/vehicle.js
 * ---------------------------------------------------------------------------
 * The public surface of the gateway.
 *
 *   GET /api/v1/vehicle/:regNo               everything, cache-first
 *   GET /api/v1/vehicle/:regNo?refresh=1     force a fresh ULIP fetch
 *   GET /api/v1/vehicle/:regNo?challans=all  full challan list inline
 *   GET /api/v1/vehicle/:regNo/rc            RC only
 *   GET /api/v1/vehicle/:regNo/challans      challans, paginated
 *       ?page=2&per_page=50&status=pending
 *   GET /api/v1/vehicle/:regNo/fastag        FASTag tags + toll crossings
 *
 * WHY THE DEFAULT IS TRIMMED: a real tourist bus returned 352 pending challans
 * in a 448 KB document. This is a WhatsApp-first product on Indian mobile data,
 * so the full document defaults to the summary plus the newest few, and the
 * complete list is a separate, paged request.
 *
 * Every response reports `calls` — the ULIP requests this lookup actually
 * spent. Free today; the day ULIP starts charging, cost per customer is
 * already measurable instead of a guess.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const plate = require('../util/plate');
const cache = require('../util/cache');
const { config } = require('../config');
const vahan = require('../ulip/vahan');
const echallan = require('../ulip/echallan');
const fastag = require('../ulip/fastag');

const router = express.Router();

const TTL = {
  rc: () => config.cache.rcMinutes,
  challan: () => config.cache.challanMinutes,
  fastag: () => config.cache.fastagMinutes,
};

const badPlate = (res, regNo, message) =>
  res.status(400).json({ success: false, error: 'invalid_registration_number', vehicle_number: regNo, message });

const notFound = (res, regNo, message) =>
  res.status(404).json({ success: false, error: 'vehicle_not_found', vehicle_number: regNo,
    message: message || 'No Government record found for this registration number.' });

/**
 * One dataset, cache-first.
 * Returns { data, source, cached, age_minutes, calls } or an error shape.
 */
async function load(kind, regNo, refresh, debug = false) {
  const key = `${kind}:${regNo}`;

  if (!refresh && !debug) {
    const hit = cache.get(key);
    if (hit) {
      // A cached "not found" is still an answer — that is the point of caching it.
      if (hit.value.notFound) return { notFound: true, cached: true, age_minutes: cache.ageMinutes(hit), calls: [] };
      return { ...hit.value, cached: true, age_minutes: cache.ageMinutes(hit), calls: [] };
    }
  }

  const fn = kind === 'rc' ? vahan.fetchRc : kind === 'challan' ? echallan.fetchChallans : fastag.fetchFastag;
  const r = await fn(regNo, { includeRaw: debug });

  if (r.ok) {
    const value = { data: r.data, source: r.source || null };
    cache.set(key, value, TTL[kind]());
    return { ...value, cached: false, age_minutes: 0, calls: r.calls, fallback: !!r.fallback };
  }

  if (r.notFound) {
    cache.set(key, { notFound: true }, config.cache.notFoundMinutes);
    return { notFound: true, cached: false, calls: r.calls, code: r.code, error: r.error };
  }
  return { failed: true, calls: r.calls, code: r.code, error: r.error };
}

const PREVIEW = 10;      // newest challans inlined in the full document
const PER_PAGE = 50;     // page size for the paginated list
const MAX_PER_PAGE = 200;

/**
 * Keep the summary and the newest few; drop the long tail.
 * `challans=all` opts back in to everything.
 */
function trimChallans(data, wantAll, regNo) {
  if (!data || wantAll) return data;
  const { pending = [], disposed = [], ...rest } = data;
  return {
    ...rest,
    pending: pending.slice(0, PREVIEW),
    disposed: disposed.slice(0, PREVIEW),
    truncated: pending.length > PREVIEW || disposed.length > PREVIEW,
    showing: { pending: Math.min(pending.length, PREVIEW), disposed: Math.min(disposed.length, PREVIEW) },
    full_list_url: `/api/v1/vehicle/${regNo}/challans`,
  };
}

/** Shared entry: validate the plate before spending anything. */
function check(req, res) {
  const { regNo, ok, error } = plate.parse(req.params.regNo);
  if (!ok) { badPlate(res, regNo, error); return null; }
  return { regNo,
           refresh: String(req.query.refresh || '') === '1',
           debug: String(req.query.debug || '') === '1',
           allChallans: String(req.query.challans || '') === 'all' };
}

/* ------------------------------------------------------------------ full */
router.get('/vehicle/:regNo', async (req, res) => {
  const ctx = check(req, res); if (!ctx) return;
  const { regNo, refresh, debug, allChallans } = ctx;
  const started = Date.now();

  try {
    // RC first and alone: if the vehicle does not exist there is no point
    // spending calls on challans and FASTag for it.
    const rc = await load('rc', regNo, refresh, debug);
    if (rc.notFound) return notFound(res, regNo, rc.error);
    if (rc.failed) {
      return res.status(503).json({ success: false, error: 'upstream_unavailable',
        vehicle_number: regNo, message: rc.error, calls: rc.calls });
    }

    const [challan, tag] = await Promise.all([
      load('challan', regNo, refresh, debug),
      load('fastag', regNo, refresh, debug),
    ]);

    const calls = [...(rc.calls || []), ...(challan.calls || []), ...(tag.calls || [])];
    res.json({
      success: true,
      vehicle_number: regNo,
      vehicle_number_pretty: plate.pretty(regNo),
      source: rc.source,
      cached: rc.cached && challan.cached && tag.cached,
      age_minutes: rc.age_minutes ?? 0,
      fetched_at: new Date().toISOString(),
      latency_ms: Date.now() - started,
      rc: rc.data,
      // A dataset that failed is reported as null with a reason, rather than
      // failing the whole document — an RC with no challan data is still useful.
      challans: challan.failed ? null
        : trimChallans(challan.data, allChallans || debug, regNo),
      challans_error: challan.failed ? challan.error : undefined,
      fastag: tag.failed ? null : tag.data,
      fastag_error: tag.failed ? tag.error : undefined,
      counts: {
        pending_challans: challan.data?.pending_count ?? null,
        pending_amount_paise: challan.data?.pending_amount_paise ?? null,
        fastag_tags: tag.data?.tag_count ?? null,
      },
      calls,
      ulip_calls_made: calls.length,
    });
  } catch (e) {
    console.error('[vehicle] unexpected:', e.message);
    res.status(500).json({ success: false, error: 'server_error', message: 'Something went wrong.' });
  }
});

/* ------------------------------------------------------- single datasets */
const single = (kind, field) => async (req, res) => {
  const ctx = check(req, res); if (!ctx) return;
  const { regNo, refresh, debug } = ctx;
  const started = Date.now();
  try {
    const r = await load(kind, regNo, refresh, debug);
    if (r.notFound) return notFound(res, regNo, r.error);
    if (r.failed) {
      return res.status(503).json({ success: false, error: 'upstream_unavailable',
        vehicle_number: regNo, message: r.error, calls: r.calls });
    }
    res.json({
      success: true, vehicle_number: regNo, source: r.source,
      cached: r.cached, age_minutes: r.age_minutes,
      latency_ms: Date.now() - started,
      [field]: r.data, calls: r.calls, ulip_calls_made: (r.calls || []).length,
    });
  } catch (e) {
    console.error(`[${kind}] unexpected:`, e.message);
    res.status(500).json({ success: false, error: 'server_error', message: 'Something went wrong.' });
  }
};

router.get('/vehicle/:regNo/rc', single('rc', 'rc'));
/**
 * Paginated challans. Defaults to pending — the ones that cost money — because
 * that is what a customer or a fleet manager is actually asking about.
 */
router.get('/vehicle/:regNo/challans', async (req, res) => {
  const ctx = check(req, res); if (!ctx) return;
  const { regNo, refresh, debug } = ctx;
  const started = Date.now();
  try {
    const r = await load('challan', regNo, refresh, debug);
    if (r.notFound) return notFound(res, regNo, r.error);
    if (r.failed) {
      return res.status(503).json({ success: false, error: 'upstream_unavailable',
        vehicle_number: regNo, message: r.error, calls: r.calls });
    }

    const status = ['pending', 'disposed', 'all'].includes(String(req.query.status))
      ? String(req.query.status) : 'pending';
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, parseInt(req.query.per_page, 10) || PER_PAGE));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const d = r.data || {};
    const rows = status === 'all'
      ? [...(d.pending || []), ...(d.disposed || [])]
      : (d[status] || []);
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / perPage));
    const slice = rows.slice((page - 1) * perPage, (page - 1) * perPage + perPage);

    res.json({
      success: true, vehicle_number: regNo,
      cached: r.cached, age_minutes: r.age_minutes,
      latency_ms: Date.now() - started,
      status, page, per_page: perPage, total, pages,
      has_more: page < pages,
      summary: d.summary,
      challans: slice,
      calls: r.calls, ulip_calls_made: (r.calls || []).length,
    });
  } catch (e) {
    console.error('[challans] unexpected:', e.message);
    res.status(500).json({ success: false, error: 'server_error', message: 'Something went wrong.' });
  }
});
router.get('/vehicle/:regNo/fastag', single('fastag', 'fastag'));

module.exports = router;
