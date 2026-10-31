#!/usr/bin/env node
/**
 * scripts/verify-plans.js — IS THE ONE-PLAN CHANGE LIVE? (user, 2026-10-31: "give some script to recheck").
 * READ-ONLY: only SELECTs, a git look-up and pm2's process list. Sends nothing.
 *
 *   node scripts/verify-plans.js
 *
 * Checks, each PASS / FAIL:
 *   the code      - the pulled commit includes the WhatsApp button fix (6381f8b) and pm2 restarted after the pull
 *   migrations    - 225, 226, 227 applied
 *   plans         - ₹29 / 50 days on sale; replace ₹23.60; packs and ₹11 off
 *   settings      - packs off, 5 a day enforced, free alerts automatic 7 days, no lookup guard, update cadence
 *   policies      - Terms / Free Monitoring / Refund name ₹29, 50 and 7 days, and no old price
 * and, for information, what happened since the change (free monitoring started, updates sent, sales).
 */
require('dotenv').config({ quiet: true });
const { execSync } = require('child_process');
const db = require('../src/db');

let bad = 0;
const ok = (pass, what, detail = '') => {
  if (!pass) bad += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
};
const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

(async () => {
  console.log('\n== the code');
  ok(sh('git merge-base --is-ancestor 6381f8b HEAD && echo yes') === 'yes', 'pulled code includes the button fix (6381f8b)', sh('git log --oneline -1'));
  // The last commit that changed the server's code - a script-only commit (like this file) needs no restart.
  const pulledAt = Number(sh('git log -1 --format=%ct -- src migrations')) * 1000;
  const pm2 = (() => { try { return JSON.parse(sh('pm2 jlist') || '[]').find((p) => p.name === 'serverpe-gaadipe'); } catch { return null; } })();
  if (pm2) {
    const up = pm2.pm2_env?.pm_uptime;
    ok(pm2.pm2_env?.status === 'online', 'pm2 serverpe-gaadipe online', pm2.pm2_env?.status);
    ok(up && up >= pulledAt, 'pm2 restarted after the last code change', up ? `up since ${new Date(up).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : 'unknown');
  } else ok(false, 'pm2 process serverpe-gaadipe found');

  console.log('\n== migrations');
  const { rows: mig } = await db.query(`SELECT filename FROM schema_migrations WHERE filename ~ '^22[5-7]_'`);
  for (const n of ['225', '226', '227']) ok(mig.some((m) => m.filename.startsWith(`${n}_`)), `migration ${n} applied`);

  console.log('\n== plans');
  const { rows: plans } = await db.query(`SELECT code, price_paise, duration_days, is_active FROM plans`);
  const p = Object.fromEntries(plans.map((r) => [r.code, r]));
  ok(p.REPORT19?.is_active && p.REPORT19.price_paise === 2900 && p.REPORT19.duration_days === 50, 'full report ₹29 · 50 days on sale',
    p.REPORT19 ? `${p.REPORT19.price_paise} paise · ${p.REPORT19.duration_days} days · ${p.REPORT19.is_active ? 'on' : 'off'}` : 'missing');
  ok(p.REPLACE9?.is_active && p.REPLACE9.price_paise === 2360, 'replace vehicle ₹23.60 (₹20 + GST)', p.REPLACE9 ? `${p.REPLACE9.price_paise} paise` : 'missing');
  for (const c of ['REPORT11', 'CHECKS5', 'CHECKS12', 'CHECKS25']) ok(!p[c]?.is_active, `${c} off sale`);

  console.log('\n== settings');
  const want = {
    check_packs_enabled: 'false', checks_enforce: 'true', free_checks_per_day: '5', free_monitor_auto: 'true',
    free_monitor_days: '7', free_check_lookup_guard: 'false', rc_backup_paid_only: 'false', watch_daily_status_enabled: 'true',
    watch_status_every_days: '2', watch_status_email_every_days: '1', watch_status_alternate_until_day: '0',
  };
  const { rows: st } = await db.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [Object.keys(want)]);
  const s = Object.fromEntries(st.map((r) => [r.key, String(r.value)]));
  for (const [k, v] of Object.entries(want)) ok(s[k] === v, `${k} = ${v}`, s[k] === v ? '' : `is ${s[k] ?? '(not set)'}`);

  console.log('\n== policies');
  const text = async (table, title) => (await db.one(`SELECT description FROM ${table} WHERE title = $1 AND is_active LIMIT 1`, [title]).catch(() => null))?.description || '';
  const buying = await text('terms_and_conditions', 'What You Are Buying');
  const freeMon = await text('terms_and_conditions', 'Free Monitoring');
  ok(/Rs\.29/.test(buying) && /50 days/.test(buying), 'Terms: report Rs.29 with 50 days');
  ok(/monitored free for 7 days/.test(freeMon) && /When the 7 days end/.test(freeMon), 'Terms: free monitoring 7 days');
  const { rows: old } = await db.query(
    `SELECT 'terms: ' || title AS t FROM terms_and_conditions WHERE is_active AND description ~ '(Rs\\.(11|19)\\M|28 days|14 days|packs of|check credits:)'
     UNION ALL SELECT 'refund: ' || title FROM refund_policy WHERE is_active AND description ~ '(Rs\\.(11|19)\\M|28 days|packs of)'`);
  ok(!old.length, 'no old price / 28 days / 14 days / packs left in the policies', old.map((r) => r.t).join(', '));

  /* No HTTP call to /site/api/pricing: the site's guard (security/guard.gate) refuses non-browser clients with 403 and
     counts repeats as misuse (2026-10-31, first run). /pricing reads exactly the plans and settings checked above, and
     pm2's restart time proves the running process has this code. */

  console.log('\n== since the change (information)');
  const since = await db.one(
    `SELECT (SELECT count(*) FROM event_log WHERE kind = 'free_monitor_started' AND detail->>'auto' = 'true')::int AS free_watch_started,
            (SELECT count(*) FROM watches w WHERE w.is_active AND w.subscription_id IS NULL AND (w.expires_at IS NULL OR w.expires_at > now()))::int AS free_watches_running,
            (SELECT count(*) FROM event_log WHERE kind = 'watch_status' AND created_at > now() - interval '24 hours')::int AS updates_24h,
            (SELECT count(*) FROM event_log WHERE kind = 'watch_status' AND created_at > now() - interval '24 hours' AND detail->>'wa' = 'true')::int AS updates_whatsapp_24h,
            (SELECT count(*) FROM event_log WHERE kind = 'vehicle_check' AND created_at > now() - interval '24 hours')::int AS checks_24h,
            -- Counted only while the lookup guard was on (before migration 226); stays 0 from then on.
            (SELECT count(*) FROM event_log WHERE kind = 'free_paid_lookup' AND created_at > now() - interval '24 hours')::int AS guarded_lookups_24h,
            (SELECT count(*) FROM payments pa JOIN plans pl ON pl.id = pa.plan_id
              WHERE pa.status = 'paid' AND pa.amount_paise = 2900 AND pl.code = 'REPORT19')::int AS sales_29`);
  console.table(since);

  console.log(bad ? `\n${bad} check(s) FAILED — see above.` : '\nAll checks passed. ✅');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('verify failed:', e.message); process.exit(1); });
