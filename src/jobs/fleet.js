/**
 * src/jobs/fleet.js — GaadiPe for fleets, on a timer (user, 2026-09-29).
 *
 * Every pass:
 *   1. checks   every vehicle of an active fleet once a day (a few per pass,
 *               so the Government service is never hit in a burst); a vehicle
 *               that failed waits an hour before the next try
 *   2. reports  from fleet_report_hour_ist (7 pm) until …_until (10 pm), one
 *               email with the Excel per active fleet per day
 *   3. renewal  fleet_renewal_notice_days (3) before the end, a renewal link is
 *               emailed once; at the end an unpaid fleet becomes 'expired' —
 *               no checks, no emails — until the renewal is paid
 */

const db = require('../db');
const settings = require('../util/settings');
const F = require('../fleet/fleets');

const PER_PASS = 25;

async function checks() {
  const { rows } = await db.query(
    `SELECT v.* FROM fleet_vehicles v JOIN fleets f ON f.id = v.fleet_id
      WHERE f.status = 'active' AND v.removed_at IS NULL
        AND (v.last_checked_at IS NULL OR v.last_checked_at < now() - interval '20 hours')
        AND (v.last_attempt_at IS NULL OR v.last_attempt_at < now() - interval '1 hour')
      ORDER BY v.last_checked_at NULLS FIRST LIMIT ${PER_PASS}`);
  const gateway = require('../vehicle/gateway');
  const store = require('../vehicle/store');
  let done = 0;
  for (const v of rows) {
    await db.query(`UPDATE fleet_vehicles SET last_attempt_at = now() WHERE id = $1`, [v.id]);
    /* NOT A PAID LOOKUP EVERY DAY (user, 2026-10-21: "₹3 goes without any reason — only when expiry nears
       or a challan is detected"). A vehicle already held: ULIP (free; commercial vehicles answer) or the
       saved RC, and one fresh paid lookup only when a document is near its date (vehicle/rcConfirm, at
       most once per rc_confirm_days). A vehicle never seen: the full chain once. */
    const opts = await require('../vehicle/rcBackup').freeOpts({}, v.reg_no).then((o) => (o.rc_saved ? o : {}));
    let data = await gateway.full(v.reg_no, { challans: 'all', ...opts }).catch((e) => ({ success: false, error: e.message }));
    let recorded = false;
    const confirm = require('../vehicle/rcConfirm');
    if (data?.success && data.rc_saved && v.vehicle_id && confirm.needsConfirm(data.rc)) {
      const fresh = await confirm.refresh({ regNo: v.reg_no, vehicleId: v.vehicle_id, why: 'fleet check' }).catch(() => null);
      if (fresh?.success) { data = { ...fresh, challans: data.challans || fresh.challans }; recorded = true; }
    }
    if (data?.success) {
      const vehicle = await store.record(null, data, { calls: !recorded }).catch(() => null);
      await db.query(`UPDATE fleet_vehicles SET vehicle_id = coalesce($2, vehicle_id), last_checked_at = now(), last_check_ok = true,
                             last_error = $3 WHERE id = $1`,
        [v.id, vehicle?.id || null, data.challans ? null : 'e-Challan did not answer']);
      done += 1;
    } else {
      await db.query(`UPDATE fleet_vehicles SET last_check_ok = false, last_error = $2 WHERE id = $1`,
        [v.id, String(data?.error || data?.message || 'lookup failed').slice(0, 200)]);
    }
  }
  return done;
}

async function reports() {
  const from = await settings.num('fleet_report_hour_ist', 19);
  const until = await settings.num('fleet_report_until_hour_ist', 22);
  const h = new Date(Date.now() + 330 * 60000).getUTCHours();
  if (h < from || h >= until) return 0;
  const today = F.istDate();
  const { rows } = await db.query(
    `SELECT f.id FROM fleets f WHERE f.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM fleet_reports r WHERE r.fleet_id = f.id AND r.ist_date = $1) ORDER BY f.id LIMIT 10`, [today]);
  let sent = 0;
  for (const r of rows) {
    const out = await F.sendReport(r.id).catch((e) => ({ ok: false, message: e.message }));
    if (out.ok) sent += 1; else console.warn('[fleet] report for fleet %s: %s', r.id, out.message);
  }
  return sent;
}

async function lifecycle() {
  // Unpaid links past their date.
  await db.query(`UPDATE fleet_payments SET status = 'expired' WHERE status = 'created' AND expires_at < now()`);

  // Renewal links, once, a few days before the end.
  const notice = await settings.num('fleet_renewal_notice_days', 3);
  const { rows: due } = await db.query(
    `SELECT f.id FROM fleets f
      WHERE f.status = 'active' AND f.ends_at <= now() + make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM fleet_payments p WHERE p.fleet_id = f.id AND p.kind = 'renewal'
                          AND p.created_at > f.ends_at - make_interval(days => $1 + 1) AND p.status IN ('created', 'paid'))`, [notice]);
  for (const f of due) {
    // The same price per vehicle as last time, for today's vehicle count.
    const last = await db.one(`SELECT amount_paise, vehicles FROM fleet_payments WHERE fleet_id = $1 AND status = 'paid' ORDER BY paid_at DESC LIMIT 1`, [f.id]);
    const count = (await db.one(`SELECT count(*)::int n FROM fleet_vehicles WHERE fleet_id = $1 AND removed_at IS NULL`, [f.id])).n;
    const amount = last && last.vehicles ? Math.round((last.amount_paise / last.vehicles) * count) : undefined;
    const out = await F.quote(f.id, { amountPaise: amount }).catch((e) => ({ ok: false, message: e.message }));
    if (!out.ok) await F.event(f.id, 'renewal_failed', `Renewal link not sent: ${out.message}`);
  }

  // The end: no renewal paid in time.
  const { rows: ended } = await db.query(
    `UPDATE fleets SET status = 'expired', modified_at = now() WHERE status = 'active' AND ends_at <= now() RETURNING id`);
  for (const f of ended) await F.event(f.id, 'expired', 'Monitoring period ended — no checks or reports until the renewal is paid');
  return due.length + ended.length;
}

async function tick() {
  const checked = await checks();
  const sent = await reports();
  const changed = await lifecycle();
  return { processed: checked + sent + changed, checked, sent };
}

function start(everySeconds = 300) {
  setInterval(require('../util/heartbeat').wrap('fleet', tick, everySeconds), everySeconds * 1000).unref();
}

module.exports = { start, tick, checks, reports, lifecycle };
