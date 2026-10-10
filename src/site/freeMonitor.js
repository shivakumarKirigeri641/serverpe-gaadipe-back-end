/**
 * src/site/freeMonitor.js — FREE MONITORING FOR ONE VEHICLE (user, 2026-10-10:
 * "on sign in, you get free 14 days automatic monitoring for expiry & challan
 * alerts for 1 vehicle, and then just Rs 19 for 28 days").
 *
 * The rules:
 *   - signed in, one vehicle they have checked, free_monitor_days (14) days
 *   - ONCE PER MOBILE NUMBER, ever — the record is kept by number in event_log,
 *     so closing the account and signing in again as a "fresh" one does not give
 *     a second free period — and once per browser (device id), so a new SIM in
 *     the same phone does not either
 *   - alerts as for paid monitoring: browser notification, email, SMS
 *   - free_monitor_notice_days (2) before the end: "continue for Rs 19" — by
 *     notification, email and SMS — once
 *   - when it ends, monitoring simply stops (jobs/watch.js lifecycle); nothing is
 *     charged, nothing renews; buying the Rs 19 report takes the same watch over
 *
 * Settings: free_monitor_enabled (true), free_monitor_days (14),
 * free_monitor_notice_days (2).
 */

const db = require('../db');
const settings = require('../util/settings');

const ten = (m) => String(m || '').replace(/\D/g, '').slice(-10);
const enabled = () => settings.bool('free_monitor_enabled', true);
const days = () => settings.num('free_monitor_days', 14);

/** Has this number — or this browser — already had its free period? */
async function usedBy(mobile, deviceId) {
  const row = await db.one(
    `SELECT detail->>'reg_no' AS reg_no, (detail->>'ends_at')::timestamptz AS ends_at, created_at
       FROM event_log
      WHERE kind = 'free_monitor_started'
        AND (detail->>'mobile' = $1 OR ($2::text IS NOT NULL AND detail->>'device_id' = $2))
      ORDER BY id LIMIT 1`, [ten(mobile), deviceId || null]);
  return row || null;
}

/** What the chat shows: can they start it, and if they had it, for which vehicle and until when. */
async function status(user, ctx = {}) {
  const on = await enabled();
  const n = await days();
  const used = await usedBy(user.mobile, ctx.device_id);
  const price = await require('../pay/billing').reportPlan().catch(() => null);
  return {
    enabled: on, days: n,
    eligible: on && !used,
    used: used ? { reg_no: used.reg_no, ends_at: used.ends_at, active: used.ends_at && new Date(used.ends_at) > new Date() } : null,
    then_price_paise: price?.price_paise ?? null,
    then_days: price?.duration_days || 28,
  };
}

/** Start it for one vehicle the customer has checked. */
async function start(user, regNo, ctx = {}) {
  if (!(await enabled())) return { ok: false, error: 'off', message: 'Free monitoring is not available right now.' };
  const reg = String(regNo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const used = await usedBy(user.mobile, ctx.device_id);
  if (used) {
    return { ok: false, error: 'used', message: `Your free monitoring has already been used (${used.reg_no}). Monitoring is Rs 19 for 28 days per vehicle.` };
  }
  const vehicle = await db.one(`SELECT id, reg_no FROM vehicles WHERE reg_no = $1`, [reg]);
  const checked = vehicle && await db.one(
    `SELECT 1 AS x FROM user_vehicles WHERE user_id = $1 AND vehicle_id = $2 LIMIT 1`, [user.id, vehicle.id]);
  if (!vehicle || !checked) return { ok: false, error: 'not_checked', message: 'Check the vehicle first, then start free monitoring for it.' };
  const watched = await db.one(
    `SELECT 1 AS x FROM watches WHERE user_id = $1 AND vehicle_id = $2 AND is_active
        AND (expires_at IS NULL OR expires_at > now())`, [user.id, vehicle.id]);
  if (watched) return { ok: false, error: 'already', message: `${reg} is already being monitored.` };

  const n = await days();
  const endsAt = new Date(Date.now() + n * 86400e3);
  const checkEvery = await settings.num('watch_check_interval_minutes', 24 * 60);
  let watchId = null;
  await db.tx(async (c) => {
    const w = await c.query(
      `INSERT INTO watches (user_id, vehicle_id, expires_on, expires_at,
                            challan_next_check_at, rc_next_check_at, fastag_next_check_at,
                            challan_interval_hours, rc_interval_hours, fastag_interval_hours)
            VALUES ($1, $2, $3, $4,
                    now() + ($5 || ' minutes')::interval,
                    now() + ($5 || ' minutes')::interval,
                    now() + ($5 || ' minutes')::interval,
                    $6, $6, $6)
       ON CONFLICT (user_id, vehicle_id) DO UPDATE
              SET is_active = true, subscription_id = NULL, expires_on = EXCLUDED.expires_on,
                  expires_at = EXCLUDED.expires_at, modified_at = now()
       RETURNING id`,
      [user.id, vehicle.id, endsAt.toISOString().slice(0, 10), endsAt.toISOString(),
       String(checkEvery), Math.max(1, Math.round(checkEvery / 60))]);
    watchId = w.rows[0].id;
    await c.query(
      `INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'free_monitor_started', $3)`,
      [user.id, vehicle.id, JSON.stringify({
        mobile: ten(user.mobile), device_id: ctx.device_id || null, reg_no: reg, watch_id: String(watchId),
        days: n, ends_at: endsAt.toISOString(), ip: ctx.ip || null,
      })]);
  });
  require('../util/activity').log('🆓', `Free monitoring started · ${reg} · ${n} days`, { who: `customer #${user.id}` });
  return { ok: true, reg_no: reg, ends_at: endsAt.toISOString(), days: n };
}

/**
 * "CONTINUE FOR RS 19" — free_monitor_notice_days before a free period ends, once,
 * by browser notification, email and SMS. Not if they already paid for it.
 */
async function noticeDue() {
  const before = await settings.num('free_monitor_notice_days', 2);
  const { rows } = await db.query(
    `SELECT e.id AS event_id, e.user_id, e.detail->>'reg_no' AS reg_no, e.detail->>'watch_id' AS watch_id,
            (e.detail->>'ends_at')::timestamptz AS ends_at,
            u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
            u.email, u.email_verified_at, u.email_unsubscribed_at, u.email_token
       FROM event_log e
       JOIN users u ON u.id = e.user_id
       JOIN watches w ON w.id = (e.detail->>'watch_id')::bigint
      WHERE e.kind = 'free_monitor_started'
        AND (e.detail->>'ends_at')::timestamptz > now()
        AND (e.detail->>'ends_at')::timestamptz <= now() + make_interval(days => $1::int)
        AND w.is_active AND w.subscription_id IS NULL
        AND u.archived_at IS NULL AND NOT u.is_paused
        AND NOT EXISTS (SELECT 1 FROM event_log n WHERE n.kind = 'free_monitor_notice'
                         AND n.detail->>'started_event' = e.id::text)`, [before]);
  if (!rows.length) return { told: 0 };
  const plan = await require('../pay/billing').reportPlan().catch(() => null);
  const price = plan ? `₹${Math.round(plan.price_paise / 100)}` : '₹19';
  const C = require('../mail/customer');
  const T = require('../mail/templates');
  const day = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  let told = 0;
  for (const r of rows) {
    // Recorded first, so a crash never sends it twice.
    await db.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'free_monitor_notice', $2)`,
      [r.user_id, JSON.stringify({ started_event: String(r.event_id), reg_no: r.reg_no, ends_at: r.ends_at })]);
    const url = `/chat?reg=${encodeURIComponent(r.reg_no)}&from=free_end`;
    const channels = [];
    const pushed = await require('./push').toCustomer(r.user_id, {
      title: `${r.reg_no}: free monitoring ends ${day(r.ends_at)}`,
      body: `Continue the alerts for ${plan?.duration_days || 28} days at ${price} — the full report included.`,
      url, tag: `free-end-${r.reg_no}`,
    }).catch(() => 0);
    if (pushed) channels.push('push');
    if (r.email && r.email_verified_at && !r.email_unsubscribed_at) {
      const name = String(r.name || '').split(' ')[0] || 'there';
      const mail = {
        subject: `${r.reg_no}: your free monitoring ends ${day(r.ends_at)} — GaadiPe`,
        ...T.layout({
          tagline: 'Free monitoring ending', badge: { text: 'Ending soon', tone: 'watch' },
          title: `Free monitoring for ${r.reg_no} ends on ${day(r.ends_at)}`,
          lead: `Hi ${name}, after that GaadiPe stops checking ${r.reg_no} for new challans and stops warning you before insurance, PUC, road tax or fitness runs out.`,
          stats: [['Vehicle', r.reg_no], ['Ends', day(r.ends_at)], ['Continue for', `${price} · ${plan?.duration_days || 28} days`]],
          blocks: [`<div style="font-size:13px;line-height:1.6;color:#41514e;">The ${price} includes the full buyer's report (loan, blacklist, every challan, the verdict and a PDF). Nothing renews automatically.</div>`],
          cta: { label: `Continue for ${price}`, url: `${C.SITE()}${url}` },
          footer: 'You are receiving this because you started free monitoring for this vehicle on GaadiPe.',
          footerHtml: r.email_token ? `<a href="${T.esc(`${C.API()}/email/unsubscribe/${r.email_token}`)}" style="color:#0f766e;">Unsubscribe</a>` : '',
        }),
      };
      const out = await C.deliver(r.email, mail, r.email_token).catch(() => ({ ok: false }));
      if (out.ok) channels.push('email');
    }
    const sms = await require('../util/sms').sendTemplate('monitor_end', r.mobile, [r.reg_no, day(r.ends_at)]);
    if (sms.ok) channels.push('sms');
    if (channels.length) told += 1;
  }
  if (told) console.log('[free-monitor] told %d customer(s) their free monitoring is ending', told);
  return { told };
}

/** For the web admin: how many started, and how many went on to pay for that vehicle. */
async function stats({ days: span = 30 } = {}) {
  return db.one(
    `SELECT count(*)::int AS started,
            count(*) FILTER (WHERE (detail->>'ends_at')::timestamptz > now())::int AS active,
            count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM payments p WHERE p.user_id = e.user_id AND p.status = 'paid' AND p.amount_paise > 0
                  AND p.raw->>'vehicle_id' = e.vehicle_id::text AND p.created_at > e.created_at))::int AS converted
       FROM event_log e WHERE e.kind = 'free_monitor_started' AND e.created_at > now() - make_interval(days => $1::int)`,
    [Number(span) || 30]);
}

module.exports = { status, start, noticeDue, usedBy, stats };
