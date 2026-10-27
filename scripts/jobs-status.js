/**
 * scripts/jobs-status.js — ARE THE SCHEDULED SENDS RUNNING? (user, 2026-10-27: "all template & email, sms going
 * automatically right as scheduled?"). Read-only; nothing is run or sent.
 *
 *   node scripts/jobs-status.js         the last 24 hours
 *   node scripts/jobs-status.js 48
 *
 *   1 every background job: runs, failures, what it did, when it last ran, its last error; paused jobs
 *   2 WhatsApp templates sent / failed, by template
 *   3 customer emails by kind and status
 *   4 SMS and push by kind and status, and what is still queued
 */
require('dotenv').config();
const db = require('../src/db');

const hours = Math.min(Math.max(parseInt(process.argv[2], 10) || 24, 1), 24 * 14);
const since = `now() - interval '${hours} hours'`;
const ist = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');
const q = async (sql) => (await db.query(sql).catch((e) => ({ rows: [{ error: e.message }] }))).rows;

(async () => {
  console.log(`\n── 1. Background jobs, last ${hours} h`);
  const paused = await db.one(`SELECT value FROM app_settings WHERE key = 'jobs_paused'`).catch(() => null);
  console.log(`   paused: ${String(paused?.value || '').trim() || 'none'}`);
  const jobs = await q(
    `SELECT job, count(*)::int AS runs, count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'paused')::int AS paused, coalesce(sum(processed), 0)::int AS did,
            max(started_at) AS last_run,
            (array_agg(left(error, 70) ORDER BY started_at DESC) FILTER (WHERE error IS NOT NULL))[1] AS last_error
       FROM job_runs WHERE started_at > ${since} GROUP BY job ORDER BY job`);
  console.table(jobs.map((j) => (j.error ? j : { job: j.job, runs: j.runs, failed: j.failed || '', paused: j.paused || '',
    did: j.did, last_run: ist(j.last_run), last_error: j.last_error || '' })));
  const quiet = await q(
    `SELECT job, max(started_at) AS last_run FROM job_runs GROUP BY job HAVING max(started_at) < ${since} ORDER BY job`);
  if (quiet.length && !quiet[0].error) {
    console.log(`   ⚠️  not run in the last ${hours} h:`);
    for (const j of quiet) console.log(`      ${j.job.padEnd(28)} last ${ist(j.last_run)}`);
  }

  console.log(`\n── 2. WhatsApp templates, last ${hours} h`);
  console.table(await q(
    `SELECT template_name AS template, count(*) FILTER (WHERE error_message IS NULL)::int AS sent,
            count(*) FILTER (WHERE error_message IS NOT NULL)::int AS failed,
            (array_agg(left(error_message, 60)) FILTER (WHERE error_message IS NOT NULL))[1] AS an_error
       FROM whatsapp_messages WHERE direction = 'out' AND template_name IS NOT NULL AND created_at > ${since}
      GROUP BY 1 ORDER BY 2 DESC`));

  console.log(`\n── 3. Customer emails, last ${hours} h`);
  console.table(await q(
    `SELECT kind, count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
            (array_agg(left(error, 60)) FILTER (WHERE status = 'failed'))[1] AS an_error
       FROM customer_emails WHERE created_at > ${since} GROUP BY 1 ORDER BY 2 DESC`));
  const stuck = await db.one(`SELECT count(*)::int AS n, min(created_at) AS oldest FROM customer_emails WHERE status = 'pending'`).catch(() => null);
  if (stuck?.n) console.log(`   pending in all: ${stuck.n} (oldest ${ist(stuck.oldest)})`);

  console.log(`\n── 4. SMS and push, last ${hours} h`);
  console.table(await q(
    `SELECT channel, kind, count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status NOT IN ('sent', 'failed'))::int AS other,
            (array_agg(left(error, 60)) FILTER (WHERE status = 'failed'))[1] AS an_error
       FROM notify_log WHERE created_at > ${since} GROUP BY 1, 2 ORDER BY 1, 3 DESC`));
  const queued = await db.one(`SELECT count(*)::int AS n, min(send_at) AS due FROM notify_queue WHERE status = 'queued'`).catch(() => null);
  console.log(`   still queued: ${queued?.n || 0}${queued?.n ? ` (first due ${ist(queued.due)})` : ''}`);
  console.log('\nNothing was run or sent.\n');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
