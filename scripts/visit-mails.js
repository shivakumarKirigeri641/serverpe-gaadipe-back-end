/**
 * scripts/visit-mails.js — WHY NO VISIT EMAILS? (user, 2026-10-29: "many mails at midnight for gaadipe visits,
 * not even one after 12 am"). Read-only.
 *
 *   node scripts/visit-mails.js          the last 24 hours, hour by hour (IST)
 *
 * Per hour: website visits recorded (web_sessions), visit emails sent / failed / skipped, then the switch, the
 * last mail error, and whether the notify job is running. Tells apart "nobody came" from "they came, no mail".
 */
require('dotenv').config();
const db = require('../src/db');

(async () => {
  const q = (sql, a) => db.query(sql, a).then((r) => r.rows).catch((e) => [{ error: e.message }]);
  const sw = await q(`SELECT key, value FROM app_settings WHERE key IN ('notify_visits', 'flag_notify_visits') OR key LIKE 'notify_visit%'`);
  console.log('\nSwitch:', sw.length ? sw.map((r) => `${r.key}=${r.value}`).join(', ') : '(no row — the default applies)');

  console.log('\nHour (IST)        visits   mailed   failed   skipped');
  const rows = await q(
    `WITH h AS (SELECT generate_series(date_trunc('hour', now() - interval '23 hours'), date_trunc('hour', now()), '1 hour') AS t)
     SELECT to_char(h.t AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:00') AS hr,
            (SELECT count(*) FROM web_sessions s WHERE s.started_at >= h.t AND s.started_at < h.t + interval '1 hour')::int AS visits,
            (SELECT count(*) FROM admin_notifications n JOIN web_sessions s ON s.session_id = n.ref
              WHERE n.kind = 'visit' AND n.status = 'sent' AND coalesce(n.sent_to, '') NOT LIKE '(%'
                AND s.started_at >= h.t AND s.started_at < h.t + interval '1 hour')::int AS mailed,
            (SELECT count(*) FROM admin_notifications n JOIN web_sessions s ON s.session_id = n.ref
              WHERE n.kind = 'visit' AND n.status = 'failed' AND s.started_at >= h.t AND s.started_at < h.t + interval '1 hour')::int AS failed,
            (SELECT count(*) FROM admin_notifications n JOIN web_sessions s ON s.session_id = n.ref
              WHERE n.kind = 'visit' AND n.status = 'sent' AND coalesce(n.sent_to, '') LIKE '(%'
                AND s.started_at >= h.t AND s.started_at < h.t + interval '1 hour')::int AS skipped
       FROM h ORDER BY h.t`);
  for (const r of rows) console.log(r.error ? r.error : `${r.hr.padEnd(16)} ${String(r.visits).padStart(7)} ${String(r.mailed).padStart(8)} ${String(r.failed).padStart(8)} ${String(r.skipped).padStart(9)}`);

  const last = await q(`SELECT created_at, status, left(coalesce(last_error, sent_to, ''), 120) AS note FROM admin_notifications
                         WHERE kind = 'visit' ORDER BY id DESC LIMIT 3`);
  console.log('\nLast 3 visit-email rows:');
  for (const r of last) console.log(r.error || `  ${new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}  ${r.status}  ${r.note}`);

  const anyMail = await q(`SELECT kind, status, count(*)::int AS n FROM admin_notifications WHERE created_at > now() - interval '12 hours'
                            GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`);
  console.log('\nAll admin emails, last 12 hours (does ANY mail go out?):');
  for (const r of anyMail) console.log(r.error || `  ${r.kind.padEnd(22)} ${r.status.padEnd(8)} ${r.n}`);

  // Every email type, hour by hour (2026-10-29: "new customer, existing customer mails are not coming").
  const kinds = await q(
    `SELECT to_char(date_trunc('hour', created_at) AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:00') AS hr, kind,
            count(*) FILTER (WHERE status = 'sent' AND coalesce(sent_to, '') NOT LIKE '(%')::int AS sent,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'sent' AND coalesce(sent_to, '') LIKE '(%')::int AS skipped
       FROM admin_notifications WHERE created_at > now() - interval '24 hours' AND kind IN ('wa_hi', 'wa_agreed', 'wa_check', 'sign_in', 'web_check', 'chat_check')
      GROUP BY 1, 2, date_trunc('hour', created_at) ORDER BY date_trunc('hour', created_at), 2`);
  console.log('\nCustomer emails by hour (wa_hi = "New / Existing customer said Hi"):');
  for (const r of kinds) console.log(r.error || `  ${r.hr}  ${r.kind.padEnd(11)} sent ${r.sent}${r.failed ? ` · FAILED ${r.failed}` : ''}${r.skipped ? ` · skipped ${r.skipped}` : ''}`);
  const his = await q(
    `SELECT to_char(date_trunc('hour', created_at) AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:00') AS hr, count(DISTINCT mobile)::int AS people
       FROM whatsapp_messages WHERE direction = 'in' AND created_at > now() - interval '12 hours'
      GROUP BY 1, date_trunc('hour', created_at) ORDER BY date_trunc('hour', created_at)`);
  console.log('\nPeople writing on WhatsApp, by hour (last 12 h):');
  console.log(his.length ? his.map((r) => r.error || `${r.hr.slice(7)}h: ${r.people}`).join(' · ') : '  none');

  const job = await q(`SELECT job, max(started_at) AS last, count(*) FILTER (WHERE status = 'failed')::int AS failed
                         FROM job_runs WHERE job = 'notify' AND started_at > now() - interval '24 hours' GROUP BY 1`);
  console.log('\nNotify job:', job[0]?.error || (job[0] ? `last ran ${new Date(job[0].last).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}, ${job[0].failed} failed runs in 24 h` : 'NOT RUN in the last 24 hours'));
  console.log('');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
