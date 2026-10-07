/**
 * src/jobs/challanFollowup.js — completing a paid report whose challans were
 * missing (user, 2026-09-27).
 *
 * The Government e-Challan service sometimes times out. A paid report issued
 * at that moment says "Pending challans: Not available". This job asks again
 * every challan_followup_every_minutes (30) for up to challan_followup_max_tries
 * (48 — a day). When it answers:
 *
 *   1. the report is re-printed with the challans — same number, same link
 *   2. the answer is stored as the vehicle's snapshot, so monitoring compares
 *      against it and does not announce the same challans a second time
 *   3. the customer is told: a free message inside the 24-hour window, else
 *      the approved gp_monitoring_alert_en_v1 (1 name, 2 vehicle, 3 status,
 *      4 action)
 *
 * Only for reports still inside their download window. Nothing at night (IST
 * 21:00–08:00): the check waits for the morning, so the news never lands at
 * midnight (the reminders' quiet hours, nudge_quiet_*). Never to anyone who replied STOP or is blocked (send.js).
 */

const db = require('../db');
const settings = require('../util/settings');
const gateway = require('../vehicle/gateway');
const send = require('../whatsapp/send');

const rupees = (paise) => '₹' + Math.round((paise || 0) / 100).toLocaleString('en-IN');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (d) => `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
// The reminders' quiet hours (IST), so there is one place to change them.
const night = async () => require('./nudge').quiet(await settings.num('nudge_quiet_from_ist', 21), await settings.num('nudge_quiet_to_ist', 8));

/** "2 pending challans · ₹1,500 to pay · most recent 12 Aug 2026" or "No pending challans ✅". */
function challanLine(c) {
  if (!(c.pending_count > 0)) return `No pending challans ✅${c.disposed_count ? ` (${c.disposed_count} already paid)` : ''}`;
  const latest = (c.pending || [])[0];
  const when = latest?.challan_date ? new Date(latest.challan_date) : null;
  return [`${c.pending_count} pending challan${c.pending_count === 1 ? '' : 's'}`, `${rupees(c.pending_amount_paise)} to pay`,
          when && !Number.isNaN(when.getTime()) ? `most recent ${fmt(when)}` : null].filter(Boolean).join(' · ');
}

/*
 * TELLING THE CUSTOMER (2026-10-07: WhatsApp is retired). By email when their
 * address is confirmed, and a browser notification on every phone where they
 * allowed it; WhatsApp only while it is switched on. Told = any of them.
 */
async function tellCustomer(r, c) {
  const C = require('../mail/customer');
  const T = require('../mail/templates');
  const line = challanLine(c);
  const site = C.SITE();
  const open = `${site}/chat?open=reports`;
  const told = [];
  if (r.email && r.email_verified_at && !r.email_unsubscribed_at) {
    const pending = c.pending_count > 0;
    const card = T.vehicleCard({ reg: r.reg_no, sub: `Report ${r.report_number}`,
      items: [{ label: 'Challans', text: line, tone: pending ? 'warn' : 'good' }] });
    const mail = T.layout({
      tagline: 'Your report is complete',
      preheader: `${r.reg_no}: ${line}`,
      badge: { text: pending ? 'Challans pending' : 'No pending challans', tone: pending ? 'watch' : 'good' },
      title: `Challans added to your report for ${r.reg_no}`,
      lead: `Hi ${String(r.name || 'there').split(' ')[0]}, the Government e-Challan service is answering again, so we checked the challans and added them to your report ${r.report_number} — same report, same download.`,
      intro: [card.html], textBlocks: [card.text],
      cta: { label: 'Open your report', url: open },
      footer: 'You are receiving this because you bought a GaadiPe report for this vehicle.',
      footerHtml: r.email_token ? `<a href="${T.esc(`${C.API()}/email/unsubscribe/${r.email_token}`)}" style="color:#0f766e;">Unsubscribe</a>` : '',
    });
    const out = await C.deliver(r.email, { subject: `${r.reg_no}: challans added to your report — GaadiPe`, ...mail }, r.email_token)
      .catch((e) => ({ ok: false, error: e.message }));
    if (out.ok) told.push('email');
  }
  const pushed = await require('../site/push').toCustomer(r.user_id, {
    title: `${r.reg_no}: challans added to your report`, body: line, url: '/chat?open=reports', tag: `challans-${r.id}`,
  }).catch(() => 0);
  if (pushed) told.push('push');
  if (require('../config').config.whatsapp.enabled) {
    const wa = await tellOnWhatsApp(r, c).catch(() => ({ ok: false }));
    if (wa?.ok) told.push('whatsapp');
  }
  return told.length ? { ok: true, via: told.join('+') } : { ok: false, error: 'no email, notifications or WhatsApp' };
}

async function tellOnWhatsApp(r, c) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const link = base && r.access_token ? `${base}/report/${r.access_token}` : null;
  const line = challanLine(c);
  if (await send.optedOut(r.mobile)) return { ok: false, error: 'opted_out' };
  if (await send.windowOpen(r.mobile)) {
    return send.text(r.mobile, `🔔 *Challan update for ${r.reg_no}*\n\n`
      + 'The Government e-Challan service is answering again, so we checked your challans:\n'
      + `${line.split(' · ').map((t) => `• ${t}`).join('\n')}\n\n`
      + `Your report ${r.report_number} now includes them${link ? ` — download it again:\n${link}` : '.'}`);
  }
  const name = String(r.name || 'there').split(' ')[0];
  const action = (c.pending_count > 0 ? 'Please clear the pending challans. ' : 'Nothing to do. ')
    + `Your report ${r.report_number} has been updated with the challan details${link ? `: ${link}` : '.'}`;
  return send.template(r.mobile, await settings.get('template_daily_status', 'gp_monitoring_alert_en_v1'),
    [name, r.reg_no, `Challan check completed: ${line}`, action],
    { language: await settings.get('wa_template_language', 'en') });
}

async function tick() {
  if (!await settings.bool('challan_followup_enabled', true)) return { processed: 0 };
  if (await night()) return { processed: 0 };
  const every = Math.max(10, await settings.num('challan_followup_every_minutes', 30));
  const maxTries = await settings.num('challan_followup_max_tries', 48);
  const { rows } = await db.query(
    `SELECT r.*, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
            u.email, u.email_verified_at, u.email_unsubscribed_at, u.email_token
       FROM vehicle_reports r JOIN users u ON u.id = r.user_id
      WHERE r.payment_id IS NOT NULL AND r.valid_until > now()
        AND r.created_at > now() - interval '3 days'
        AND r.challan_completed_at IS NULL AND r.challan_tries < $1
        AND coalesce(jsonb_typeof(r.snapshot->'challans'), 'null') = 'null'
        AND (r.challan_next_try_at IS NULL OR r.challan_next_try_at <= now())
      ORDER BY r.id LIMIT 10`, [maxTries]);

  let completed = 0;
  for (const r of rows) {
    // Claimed for the next interval first: a slow answer cannot be asked twice.
    const mine = await db.one(
      `UPDATE vehicle_reports SET challan_tries = challan_tries + 1,
              challan_next_try_at = now() + make_interval(mins => $2)
        WHERE id = $1 AND challan_completed_at IS NULL
          AND (challan_next_try_at IS NULL OR challan_next_try_at <= now())
      RETURNING challan_tries`, [r.id, every]);
    if (!mine) continue;

    const data = await gateway.full(r.reg_no, { challans: 'all' }).catch(() => null);
    if (!data?.success || !data.challans) {
      if (mine.challan_tries >= maxTries) console.warn('[challan-followup] %s: gave up after %d tries', r.report_number, mine.challan_tries);
      continue;
    }

    const snapshot = { ...(r.snapshot || {}), challans: data.challans, challans_error: undefined,
                       counts: { ...(r.snapshot?.counts || {}), ...(data.counts || {}) },
                       challans_completed_at: new Date().toISOString() };
    await require('../pay/report').rebuild(r, snapshot);
    await require('../vehicle/store').record(r.user_id, data).catch((e) => console.error('[challan-followup] store:', e.message));
    await db.query(`UPDATE vehicle_reports SET challan_completed_at = now() WHERE id = $1`, [r.id]);

    const out = await tellCustomer(r, data.challans).catch((e) => ({ ok: false, error: e.message }));
    require('../events/track').fire({
      key: `challan_followup:${r.id}`, name: 'report_challans_completed', channel: 'system',
      userId: r.user_id, mobile: r.mobile, regNo: r.reg_no, paymentId: r.payment_id,
      status: out?.ok ? 'ok' : 'failed', errorCode: out?.ok ? null : String(out?.error || '').slice(0, 60),
      meta: { report_number: r.report_number, pending: data.challans.pending_count ?? null, tries: mine.challan_tries },
    });
    console.log('[challan-followup] %s completed after %d tries; customer %s', r.report_number, mine.challan_tries,
      out?.ok ? 'told' : `not told (${out?.error})`);
    completed += 1;
  }
  return { processed: completed };
}

function start(everySeconds = 300) {
  setInterval(require('../util/heartbeat').wrap('challanFollowup', tick, everySeconds), everySeconds * 1000).unref();
}

module.exports = { start, tick, challanLine };
