/**
 * src/admin/alerts.js — the alert center (user, 2026-09-25, command center
 * phase 6).
 * ---------------------------------------------------------------------------
 *   check()          every rule, once; raise what trips, resolve what cleared.
 *                    Run every minute by the alerts job.
 *   list(), ack(), resolve()   for the Alerts screen.
 *   feed(since)      what the panel pops up as it happens: payments,
 *                    new alerts, recoveries.
 *   badges()         the counts beside menu items.
 *
 * One open alert per condition (rule_key, a partial unique index): while it
 * stays tripped the same alert is seen again, not raised again.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const settings = require('../util/settings');
const heartbeat = require('../util/heartbeat');

/** Raise, or refresh, the one open alert for this rule. True if it is new. */
async function raise({ key, severity, source, title, description, detail = {} }) {
  // A muted rule (Alert rules screen) raises nothing until the mute ends.
  if (await require('./config').isMuted(key).catch(() => false)) return false;
  const r = await db.one(
    `INSERT INTO admin_alerts (rule_key, severity, source, title, description, detail)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (rule_key) WHERE status <> 'resolved'
     DO UPDATE SET last_seen_at = now(), seen_count = admin_alerts.seen_count + 1,
                   severity = EXCLUDED.severity, title = EXCLUDED.title,
                   description = EXCLUDED.description, detail = EXCLUDED.detail
     RETURNING (xmax = 0) AS inserted, id`,
    [key, severity, source, title, description || null, JSON.stringify(detail)]);
  return r?.inserted;
}

/** The condition cleared: resolve its open alert, if any. */
async function clear(key, resolution = 'Cleared by itself') {
  await db.query(
    `UPDATE admin_alerts SET status = 'resolved', resolved_at = now(), resolution = $2
      WHERE rule_key = $1 AND status <> 'resolved'`, [key, resolution]);
}
const toggle = async (tripped, alert) => (tripped ? raise(alert) : clear(alert.key));

const istNow = () => new Date(Date.now() + 330 * 60000);

async function check() {
  if (String(await settings.get('alerts_enabled', 'true')) === 'false') return { skipped: true };
  const s = {
    apiErr: await settings.num('alert_api_error_pct', 20),
    apiP95: await settings.num('alert_api_p95_ms', 8000),
    waPct: await settings.num('alert_wa_failure_pct', 10),
    payFail: await settings.num('alert_payment_failures_hour', 3),
    spike: await settings.num('alert_traffic_spike_pct', 40),
    target: await settings.num('alert_daily_revenue_target_paise', 0),
  };

  const [api15, api30, wa, pay, missing, mail, traffic, today] = await Promise.all([
    db.one(`SELECT count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed,
                   (SELECT coalesce(error_message, error_code, outcome) FROM api_calls WHERE NOT ok ORDER BY id DESC LIMIT 1) AS last_error
              FROM api_calls WHERE NOT cache_hit AND created_at > now() - interval '15 minutes'`),
    db.one(`SELECT count(*)::int AS calls,
                   round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95
              FROM api_calls WHERE NOT cache_hit AND created_at > now() - interval '30 minutes'`),
    db.one(`SELECT count(*)::int AS sent,
                   count(*) FILTER (WHERE m.error_message IS NOT NULL OR EXISTS (
                     SELECT 1 FROM whatsapp_status_logs st WHERE st.wa_message_id = m.wa_message_id AND st.status = 'failed'))::int AS failed
              FROM whatsapp_messages m WHERE m.direction = 'out' AND m.created_at > now() - interval '60 minutes'`),
    db.one(`SELECT count(DISTINCT detail->>'reference_id')::int AS n FROM event_log
             WHERE kind = 'razorpay_webhook' AND detail->>'event' = 'payment.failed' AND created_at > now() - interval '60 minutes'`),
    db.one(`SELECT count(*)::int AS n FROM payments p JOIN plans pl ON pl.id = p.plan_id
             WHERE p.status = 'paid' AND pl.kind = 'report' AND p.paid_at < now() - interval '10 minutes'
               AND p.paid_at > now() - interval '48 hours'
               AND NOT EXISTS (SELECT 1 FROM vehicle_reports r WHERE r.payment_id = p.id)`),
    db.one(`SELECT count(*)::int AS n FROM admin_notifications WHERE status = 'failed' AND attempts >= 5
             AND created_at > now() - interval '24 hours'`).catch(() => ({ n: 0 })),
    db.one(`SELECT (SELECT count(DISTINCT visitor_id) FROM events WHERE channel = 'web' AND occurred_at > now() - interval '60 minutes')::int AS hour,
                   (SELECT count(DISTINCT visitor_id)::numeric / (7 * 24) FROM events
                     WHERE channel = 'web' AND occurred_at > now() - interval '7 days' AND occurred_at <= now() - interval '60 minutes') AS avg_hour`),
    db.one(`SELECT coalesce(sum(amount_paise), 0)::int AS gross FROM payments
             WHERE status = 'paid' AND paid_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`),
  ]);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const apiRate = pct(api15.failed, api15.calls);
  const waRate = pct(wa.failed, wa.sent);

  await toggle(api15.calls >= 3 && apiRate >= 50, {
    key: 'records_api_down', severity: 'critical', source: 'records_api', title: 'Vehicle records API unavailable',
    description: `${api15.failed} of ${api15.calls} live calls failed in the last 15 minutes. Last error: ${api15.last_error || '—'}`,
    detail: { ...api15, error_pct: apiRate } });
  await toggle(api15.calls >= 3 && apiRate >= s.apiErr && apiRate < 50, {
    key: 'records_api_errors', severity: 'warning', source: 'records_api', title: 'Vehicle records API failing',
    description: `${apiRate}% of live calls failed in the last 15 minutes (threshold ${s.apiErr}%).`, detail: { ...api15, error_pct: apiRate } });
  await toggle(api30.calls >= 3 && (api30.p95 || 0) > s.apiP95, {
    key: 'records_api_slow', severity: 'warning', source: 'records_api', title: 'Vehicle records API latency high',
    description: `The slowest 5% of calls took over ${api30.p95} ms in the last 30 minutes (threshold ${s.apiP95} ms).`, detail: api30 });
  await toggle(wa.sent >= 5 && waRate >= s.waPct, {
    key: 'whatsapp_failures', severity: 'warning', source: 'whatsapp', title: 'WhatsApp delivery failures increased',
    description: `${wa.failed} of ${wa.sent} messages failed in the last hour (${waRate}%, threshold ${s.waPct}%).`, detail: { ...wa, error_pct: waRate } });
  await toggle(pay.n >= s.payFail, {
    key: 'payment_failures', severity: 'warning', source: 'payments', title: 'Payment failures increased',
    description: `${pay.n} payment${pay.n === 1 ? '' : 's'} had a failed attempt in the last hour (threshold ${s.payFail}).`, detail: pay });
  await toggle(missing.n > 0, {
    key: 'reports_missing', severity: 'critical', source: 'reports', title: 'Paid reports not generated',
    description: `${missing.n} report payment${missing.n === 1 ? '' : 's'} older than 10 minutes with no report. The customer paid and has nothing yet.`, detail: missing });
  await toggle(mail.n >= 3, {
    key: 'email_failing', severity: 'warning', source: 'email', title: 'Admin emails failing',
    description: `${mail.n} admin emails gave up after 5 attempts in the last 24 hours. Check the mail settings.`, detail: mail });

  for (const j of heartbeat.status()) {
    await toggle(j.late, {
      key: `job_late:${j.name}`, severity: 'warning', source: 'jobs', title: `Background job late: ${j.name}`,
      description: `Meant to run every ${j.every_s}s; last finished ${j.last_end ? `${Math.round(j.seconds_since / 60)} min ago` : 'never'}.${j.last_error ? ` Last error: ${j.last_error}` : ''}`,
      detail: { every_s: j.every_s, seconds_since: j.seconds_since, last_error: j.last_error } });
  }

  // The server and the backups (operations module phase 5). Thresholds in Settings.
  const infra = await require('./infra').alertFacts().catch(() => ({}));
  const lim = { disk: await settings.num('alert_disk_pct', 80), mem: await settings.num('alert_memory_pct', 90),
                ssl: await settings.num('alert_ssl_days', 14), dom: await settings.num('alert_domain_days', 30) };
  await toggle((infra.disk?.used_pct ?? 0) >= lim.disk, {
    key: 'disk_high', severity: (infra.disk?.used_pct ?? 0) >= 95 ? 'critical' : 'warning', source: 'infrastructure', title: 'Disk usage high',
    description: `Disk ${infra.disk?.used_pct}% used (${infra.disk?.free_gb} GB free) — threshold ${lim.disk}%.`, detail: infra.disk || {} });
  await toggle((infra.memory?.used_pct ?? 0) >= lim.mem, {
    key: 'memory_high', severity: 'warning', source: 'infrastructure', title: 'Server memory high',
    description: `Memory ${infra.memory?.used_pct}% used — threshold ${lim.mem}%.`, detail: infra.memory || {} });
  await toggle(infra.ssl?.days_left != null && infra.ssl.days_left <= lim.ssl, {
    key: 'ssl_expiring', severity: (infra.ssl?.days_left ?? 99) <= 3 ? 'critical' : 'warning', source: 'infrastructure', title: 'SSL certificate expiring',
    description: `The certificate for ${infra.ssl?.host} expires in ${infra.ssl?.days_left} days.`, detail: infra.ssl || {} });
  await toggle(infra.domain?.days_left != null && infra.domain.days_left <= lim.dom, {
    key: 'domain_expiring', severity: 'warning', source: 'infrastructure', title: 'Domain registration expiring',
    description: `${infra.domain?.domain} expires in ${infra.domain?.days_left} days.`, detail: infra.domain || {} });
  const bk = await require('./backups').status().catch(() => null);
  if (bk) {
    await toggle(bk.state === 'failed', {
      key: 'backup_failed', severity: 'critical', source: 'backups', title: 'Database backup failed',
      description: `The last backup attempt failed${bk.last_attempt?.error ? `: ${bk.last_attempt.error}` : ''}.`, detail: { at: bk.last_attempt?.at } });
    await toggle(bk.state === 'stale' || bk.state === 'none', {
      key: 'backup_stale', severity: 'warning', source: 'backups', title: bk.state === 'none' ? 'No database backup on record' : 'Database backup is stale',
      description: bk.state === 'none' ? 'No backup has been taken — download one from Maintenance, or switch on scheduled backups.'
        : `The last backup is ${bk.age_hours} hours old (threshold ${bk.stale_after_hours} h).`, detail: { age_hours: bk.age_hours } });
  }

  // Once per hour and per day: these are news, not faults.
  const hourKey = istNow().toISOString().slice(0, 13);
  const avg = Number(traffic.avg_hour || 0);
  if (traffic.hour >= 20 && avg > 0 && traffic.hour >= avg * (1 + s.spike / 100)) {
    await raise({ key: `traffic_spike:${hourKey}`, severity: 'info', source: 'traffic', title: 'Traffic spike detected',
      description: `${traffic.hour} website visitors in the last hour — ${Math.round((traffic.hour / avg - 1) * 100)}% above the 7-day hourly average of ${avg.toFixed(1)}.`,
      detail: { hour: traffic.hour, avg_hour: avg } });
  }
  if (s.target > 0 && today.gross >= s.target) {
    await raise({ key: `revenue_target:${hourKey.slice(0, 10)}`, severity: 'success', source: 'revenue', title: 'Revenue crossed the daily target',
      description: `₹${(today.gross / 100).toLocaleString('en-IN')} today, target ₹${(s.target / 100).toLocaleString('en-IN')}.`, detail: today });
  }
  // News of an earlier hour or day is closed when it is no longer current.
  await db.query(
    `UPDATE admin_alerts SET status = 'resolved', resolved_at = now(), resolution = 'Period ended'
      WHERE status <> 'resolved' AND ((rule_key LIKE 'traffic_spike:%' AND rule_key <> $1)
         OR (rule_key LIKE 'revenue_target:%' AND rule_key <> $2 AND status = 'acknowledged'))`,
    [`traffic_spike:${hourKey}`, `revenue_target:${hourKey.slice(0, 10)}`]);
  return { ok: true };
}

/* ─────────────────────────────── the screen ─────────────────────────────── */

const SEVERITY_ORDER = `CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END`;

async function list({ status = 'active', severity = null, limit = 100 } = {}) {
  const where = status === 'active' ? `status <> 'resolved'` : status === 'resolved' ? `status = 'resolved'` : 'true';
  const { rows } = await db.query(
    `SELECT a.*, ak.name AS acknowledged_by_name, rs.name AS resolved_by_name
       FROM admin_alerts a
       LEFT JOIN admin_users ak ON ak.id = a.acknowledged_by
       LEFT JOIN admin_users rs ON rs.id = a.resolved_by
      WHERE ${where} AND ($1::text IS NULL OR a.severity = $1)
      ORDER BY ${status === 'active' ? `${SEVERITY_ORDER}, ` : ''}a.created_at DESC LIMIT $2`,
    [/^(critical|warning|info|success)$/.test(String(severity)) ? severity : null, Math.min(500, limit)]);
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

async function ack(id, adminId) {
  const { rowCount } = await db.query(
    `UPDATE admin_alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2
      WHERE id = $1 AND status = 'open'`, [id, adminId]);
  return rowCount > 0;
}
async function resolve(id, adminId, note) {
  const { rowCount } = await db.query(
    `UPDATE admin_alerts SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution = $3
      WHERE id = $1 AND status <> 'resolved'`, [id, adminId, String(note || 'Resolved by hand').slice(0, 300)]);
  return rowCount > 0;
}

/* ─────────────────────────── pop-ups and badges ─────────────────────────── */

/** Everything worth a pop-up since `since` (an ISO time), oldest first. */
async function feed(since) {
  const from = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : new Date(Date.now() - 60000);
  const [paid, opened, recovered] = await Promise.all([
    db.query(
      `SELECT e.id, e.occurred_at AS at, e.amount_paise, e.reg_no, coalesce(e.mobile, u.mobile) AS mobile,
              coalesce(u.display_name, u.wa_profile_name) AS person_name, e.metadata->>'method' AS method,
              coalesce((SELECT vi.first_touch->>'source' FROM visitors vi WHERE vi.mobile = u.mobile ORDER BY vi.first_seen_at LIMIT 1),
                       (SELECT CASE WHEN ws.attribution->>'channel' = 'whatsapp_ad' THEN 'meta_ads' END FROM whatsapp_sessions ws WHERE ws.mobile = u.mobile),
                       'whatsapp_direct') AS source
         FROM events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.name = 'payment_success' AND e.occurred_at > $1 ORDER BY e.occurred_at LIMIT 20`, [from]),
    db.query(`SELECT id, created_at AS at, severity, source, title, description FROM admin_alerts
               WHERE created_at > $1 ORDER BY created_at LIMIT 20`, [from]),
    db.query(`SELECT id, resolved_at AS at, severity, source, title FROM admin_alerts
               WHERE resolved_at > $1 AND resolved_by IS NULL AND resolution = 'Cleared by itself'
               ORDER BY resolved_at LIMIT 20`, [from]),
  ]);
  const items = [
    ...paid.rows.map((p) => ({ kind: 'payment', id: `pay:${p.id}`, at: p.at, tone: 'good',
      title: 'Payment received', amount_paise: p.amount_paise, reg_no: p.reg_no, source: p.source,
      person: p.person_name || p.mobile, mobile: p.mobile, method: p.method })),
    ...opened.rows.map((a) => ({ kind: 'alert', id: `alert:${a.id}`, at: a.at,
      tone: a.severity === 'critical' ? 'wrong' : a.severity === 'warning' ? 'watch' : a.severity === 'success' ? 'good' : 'info',
      severity: a.severity, title: a.title, text: a.description })),
    ...recovered.rows.map((a) => ({ kind: 'recovered', id: `ok:${a.id}`, at: a.at, tone: 'good',
      title: `Recovered: ${a.title}`, text: 'The condition cleared by itself.' })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  return { items, at: new Date().toISOString() };
}

async function badges() {
  return db.one(
    `SELECT (SELECT count(DISTINCT mobile) FROM whatsapp_messages
              WHERE direction = 'in' AND created_at > now() - interval '15 minutes')::int AS whatsapp_live,
            (SELECT count(*) FROM admin_alerts WHERE status = 'open')::int AS alerts_open,
            (SELECT count(*) FROM admin_alerts WHERE status = 'open' AND severity = 'critical')::int AS alerts_critical,
            (SELECT count(*) FROM payments WHERE status = 'created' AND created_at > now() - interval '30 minutes')::int AS payments_pending,
            -- The Vehicles menu item: today's vehicle lookups (IST day).
            (SELECT count(*) FROM events WHERE name IN ('vehicle_search_success', 'vehicle_search_failed')
                AND occurred_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS vehicles_today`);
}

module.exports = { check, list, ack, resolve, feed, badges, raise, clear };
