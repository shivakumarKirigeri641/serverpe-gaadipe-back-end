/**
 * src/admin/health.js — is anything broken? Every service GaadiPe depends on,
 * one state each (user, 2026-09-25, command center phase 6).
 * ---------------------------------------------------------------------------
 * Each service is Operational, Degraded, Warning or Down, with the figures the
 * judgement came from — response time, error count and rate, the last success
 * and the last failure with its message — so "Down" is never a mystery.
 *
 *   website          gaadipe.in answers (fetched from here, cached a minute)
 *   backend          this process: up, uptime, memory
 *   database         a round trip
 *   records_api      api_calls, the last 60 minutes
 *   whatsapp_api     outgoing messages and WhatsApp's failure receipts, last hour
 *   whatsapp_webhook when Meta last delivered a message to us
 *   payment_gateway  Razorpay: failed attempts, stuck payments, the last webhook
 *   jobs             every background job's heartbeat
 *   reports          report generation and delivery, last 24 hours
 *   email            the admin and customer mail queues
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const config = require('../config').config;
const heartbeat = require('../util/heartbeat');
const settings = require('../util/settings');

const LEVEL = { operational: 0, warning: 1, degraded: 2, down: 3 };
const worst = (...ls) => ls.reduce((a, b) => (LEVEL[b] > LEVEL[a] ? b : a), 'operational');

let siteCache = { at: 0, v: null };
async function website() {
  if (Date.now() - siteCache.at < 60000 && siteCache.v) return siteCache.v;
  const url = (process.env.SITE_URL || 'https://gaadipe.in').replace(/\/+$/, '');
  const t = Date.now();
  let v;
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000), redirect: 'follow' });
    const ms = Date.now() - t;
    v = { level: r.ok ? (ms > 3000 ? 'degraded' : 'operational') : 'down', response_ms: ms, http_status: r.status,
          message: r.ok ? `${url} answered ${r.status}` : `${url} answered ${r.status}` };
  } catch (e) {
    v = { level: 'down', response_ms: Date.now() - t, http_status: null, message: `${url}: ${e.message}` };
  }
  siteCache = { at: Date.now(), v };
  return v;
}

async function services() {
  const t0 = Date.now();
  await db.one('SELECT 1 AS ok');
  const dbMs = Date.now() - t0;

  const apiErrPct = await settings.num('alert_api_error_pct', 20);
  const apiP95 = await settings.num('alert_api_p95_ms', 8000);
  const waPct = await settings.num('alert_wa_failure_pct', 10);

  const [api, wa, hook, pay, rep, mail, site] = await Promise.all([
    db.one(`SELECT count(*) FILTER (WHERE NOT cache_hit)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed,
                   count(*) FILTER (WHERE error_code ILIKE '%timeout%' OR outcome ILIKE '%timeout%')::int AS timeouts,
                   round(avg(duration_ms) FILTER (WHERE NOT cache_hit))::int AS avg_ms,
                   round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE NOT cache_hit))::int AS p95_ms,
                   (SELECT max(created_at) FROM api_calls WHERE ok) AS last_ok,
                   (SELECT max(created_at) FROM api_calls WHERE NOT ok) AS last_failure,
                   (SELECT coalesce(error_message, error_code, outcome) FROM api_calls WHERE NOT ok ORDER BY id DESC LIMIT 1) AS last_error
              FROM api_calls WHERE created_at > now() - interval '60 minutes'`),
    db.one(`SELECT count(*)::int AS sent,
                   count(*) FILTER (WHERE m.error_message IS NOT NULL
                                    OR EXISTS (SELECT 1 FROM whatsapp_status_logs s WHERE s.wa_message_id = m.wa_message_id AND s.status = 'failed'))::int AS failed,
                   (SELECT max(created_at) FROM whatsapp_messages WHERE direction = 'out' AND error_message IS NULL) AS last_ok,
                   (SELECT max(created_at) FROM whatsapp_messages WHERE direction = 'out' AND error_message IS NOT NULL) AS last_failure,
                   (SELECT error_message FROM whatsapp_messages WHERE direction = 'out' AND error_message IS NOT NULL ORDER BY id DESC LIMIT 1) AS last_error
              FROM whatsapp_messages m WHERE m.direction = 'out' AND m.created_at > now() - interval '60 minutes'`),
    db.one(`SELECT max(created_at) AS last_in FROM whatsapp_messages WHERE direction = 'in'`),
    db.one(`SELECT (SELECT count(*) FROM payments WHERE status = 'created' AND created_at < now() - interval '10 minutes'
                     AND created_at > now() - interval '24 hours')::int AS stuck,
                   (SELECT count(*) FROM event_log WHERE kind = 'razorpay_webhook' AND detail->>'event' = 'payment.failed'
                     AND created_at > now() - interval '60 minutes')::int AS failed_hour,
                   (SELECT max(created_at) FROM event_log WHERE kind = 'razorpay_webhook') AS last_webhook,
                   (SELECT max(paid_at) FROM payments WHERE status = 'paid') AS last_paid`),
    db.one(`SELECT count(*) FILTER (WHERE name = 'report_generated')::int AS generated,
                   count(*) FILTER (WHERE name = 'report_delivered' AND status <> 'ok')::int AS undelivered,
                   (SELECT count(*) FROM payments p JOIN plans pl ON pl.id = p.plan_id
                     WHERE p.status = 'paid' AND pl.kind = 'report' AND p.paid_at > now() - interval '24 hours'
                       AND NOT EXISTS (SELECT 1 FROM vehicle_reports r WHERE r.payment_id = p.id))::int AS missing,
                   max(occurred_at) FILTER (WHERE name = 'report_generated') AS last_ok
              FROM events WHERE occurred_at > now() - interval '24 hours'`),
    db.one(`SELECT (SELECT count(*) FROM admin_notifications WHERE status = 'failed' AND created_at > now() - interval '24 hours')::int AS admin_failed,
                   (SELECT count(*) FROM admin_notifications WHERE status = 'sent' AND created_at > now() - interval '24 hours')::int AS admin_sent,
                   (SELECT max(sent_at) FROM admin_notifications WHERE status = 'sent') AS last_ok,
                   (SELECT last_error FROM admin_notifications WHERE status = 'failed' ORDER BY id DESC LIMIT 1) AS last_error`).catch(() => ({})),
    website(),
  ]);

  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const apiRate = pct(api.failed, api.calls);
  const waRate = pct(wa.failed, wa.sent);
  const jobs = heartbeat.status();
  const mem = process.memoryUsage();

  const list = [
    { key: 'website', name: 'Website', ...site, metrics: { response_ms: site.response_ms, http_status: site.http_status } },
    { key: 'backend', name: 'Backend API', level: 'operational', message: `Up ${Math.round(process.uptime() / 60)} min`,
      metrics: { uptime_min: Math.round(process.uptime() / 60), memory_mb: Math.round(mem.rss / 1048576) } },
    { key: 'database', name: 'Database', level: dbMs > 1000 ? 'degraded' : 'operational', message: `Round trip ${dbMs} ms`,
      metrics: { response_ms: dbMs } },
    { key: 'records_api', name: 'Vehicle records API',
      level: !api.calls ? 'operational' : apiRate >= 50 ? 'down' : apiRate >= apiErrPct ? 'degraded'
        : (api.p95_ms || 0) > apiP95 ? 'warning' : apiRate > 0 ? 'warning' : 'operational',
      message: !api.calls ? 'No live calls in the last hour' : `${api.calls} calls, ${apiRate}% failed, p95 ${api.p95_ms ?? '—'} ms`,
      metrics: { calls: api.calls, failed: api.failed, error_pct: apiRate, timeouts: api.timeouts, avg_ms: api.avg_ms, p95_ms: api.p95_ms },
      last_ok: api.last_ok, last_failure: api.last_failure, last_error: api.last_error },
    { key: 'whatsapp_api', name: 'WhatsApp API',
      level: !config.whatsapp.enabled ? 'warning' : !wa.sent ? 'operational' : waRate >= 50 ? 'down' : waRate >= waPct ? 'degraded' : waRate > 0 ? 'warning' : 'operational',
      message: !config.whatsapp.enabled ? 'WhatsApp is switched off' : !wa.sent ? 'Nothing sent in the last hour' : `${wa.sent} sent, ${waRate}% failed`,
      metrics: { sent: wa.sent, failed: wa.failed, error_pct: waRate },
      last_ok: wa.last_ok, last_failure: wa.last_failure, last_error: wa.last_error },
    { key: 'whatsapp_webhook', name: 'WhatsApp webhook', level: 'operational',
      message: hook.last_in ? `Last message received ${Math.round((Date.now() - new Date(hook.last_in)) / 60000)} min ago` : 'No message received yet',
      metrics: {}, last_ok: hook.last_in },
    { key: 'payment_gateway', name: 'Payment gateway (Razorpay)',
      level: pay.failed_hour >= 3 ? 'degraded' : pay.stuck > 3 ? 'warning' : 'operational',
      message: `${pay.failed_hour} failed attempt${pay.failed_hour === 1 ? '' : 's'} this hour · ${pay.stuck} unpaid over 10 minutes today`,
      metrics: { failed_hour: pay.failed_hour, stuck_today: pay.stuck },
      last_ok: pay.last_paid, last_webhook: pay.last_webhook },
    { key: 'jobs', name: 'Background jobs',
      level: jobs.some((j) => j.late) ? 'degraded' : jobs.some((j) => j.state === 'error') ? 'warning' : 'operational',
      message: jobs.some((j) => j.late) ? `Late: ${jobs.filter((j) => j.late).map((j) => j.name).join(', ')}`
        : `${jobs.length} jobs running`,
      metrics: { jobs: jobs.length }, jobs },
    { key: 'reports', name: 'Report generation',
      level: rep.missing ? 'degraded' : rep.undelivered ? 'warning' : 'operational',
      message: `${rep.generated} generated in 24 h${rep.missing ? `, ${rep.missing} paid without a report` : ''}${rep.undelivered ? `, ${rep.undelivered} not delivered as PDF` : ''}`,
      metrics: { generated: rep.generated, missing: rep.missing, undelivered: rep.undelivered }, last_ok: rep.last_ok },
    { key: 'email', name: 'Email',
      level: (mail.admin_failed || 0) >= 5 ? 'degraded' : mail.admin_failed ? 'warning' : 'operational',
      message: `${mail.admin_sent || 0} admin emails sent in 24 h${mail.admin_failed ? `, ${mail.admin_failed} failed` : ''}`,
      metrics: { sent: mail.admin_sent || 0, failed: mail.admin_failed || 0 }, last_ok: mail.last_ok, last_error: mail.last_error },
  ];
  return { overall: worst(...list.map((s) => s.level)), services: list, at: new Date().toISOString() };
}

module.exports = { services, worst };
