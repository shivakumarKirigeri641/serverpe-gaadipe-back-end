/**
 * src/admin/config.js — Business Configuration, Feature Flags and alert rules
 * (user, 2026-09-25, operations module phase 6).
 * ---------------------------------------------------------------------------
 *   overview()          the business values grouped for people: the report
 *                       price (plans), GST rate, gateway fee, WhatsApp and
 *                       records-API costs, report validity — and the change
 *                       history, each change with before and after
 *   setGst(...)         a new GST rate from a date (owner only; the old rate
 *                       is closed, never overwritten)
 *   flags() / setFlag   the feature switches (src/util/flags.js)
 *   rules() / mute()    alert rules: what each watches, its thresholds (kept
 *                       in Settings), and a mute until a time
 *
 * Values are changed through the existing, audited routes — PUT /settings and
 * PUT /plans/:code — so a change here is the same change as on Settings.
 * Referral settings are not shown: GaadiPe has no referral programme for now.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const settings = require('../util/settings');
const flagsMod = require('../util/flags');

const GROUPS = [
  ['Gateway (Razorpay)', [
    ['razorpay_fee_percent', 'Fee %', 'Used only when Razorpay has not reported a payment’s actual fee.'],
    ['razorpay_fee_gst_percent', 'GST on the fee %', ''],
  ]],
  ['WhatsApp cost per business message (paise)', [
    ['whatsapp_cost_paise_marketing', 'Marketing', 'From Meta’s rate card or invoice.'],
    ['whatsapp_cost_paise_utility', 'Utility', ''],
    ['whatsapp_cost_paise_authentication', 'Authentication', ''],
    ['whatsapp_message_cost_paise', 'Any other template', 'Also the fallback for the three above.'],
    ['sms_otp_cost_paise', 'Sign-in SMS (paise)', ''],
  ]],
  ['Vehicle records API cost per call (paise)', [
    ['ulip_cost_paise_vahan', 'VAHAN (RC)', ''], ['ulip_cost_paise_challan', 'eChallan', ''],
    ['ulip_cost_paise_fastag', 'FASTag', ''], ['cache_hit_cost_paise', 'Served from cache', ''],
  ]],
  ['Reports', [
    ['report_valid_days', 'Report download window (days)', ''],
    ['vehicle_expiring_days', '“Expiring soon” means within (days)', ''],
  ]],
  // WhatsApp limits, the outage waiting list and the summary on your own WhatsApp (user, 2026-10-01).
  ['WhatsApp & outages', [
    ['whatsapp_messaging_limit', 'Meta messaging limit (people per 24 h)', 'As shown in WhatsApp Manager — 250, then 2,000 once upgraded.'],
    // The notice at the top of gaadipe.in (user, 2026-10-07).
    ['site_notice_on', 'Website notice: show it (true / false)', 'A line at the top of every page of gaadipe.in — e.g. while WhatsApp is unavailable.'],
    ['site_notice_en', 'Website notice: English text', ''],
    ['site_notice_hi', 'Website notice: Hindi text', ''],
    ['site_notice_tone', 'Website notice: look (warn / good)', 'warn = yellow ⚠️ (something is down); good = green ✅ (good news). GaadiPe is web-only since 21 Oct 2026, so no WhatsApp button is shown.'],
    // Referral rewards (user, 2026-10-08: hidden for now).
    ['referral_rewards_enabled', 'Referral rewards: offer and use them (true / false)', 'false: no free report and no reduced-price report — everyone pays the plan price. Rewards already earned are kept for when it is switched on.'],
    // Sign in for every check (user, 2026-10-08).
    ['check_sign_in_required', 'Sign-in required for every vehicle check (true / false)', 'true: a visitor signs in with their mobile before any check. false: one free check a day without signing in — make, model name and fuel, after “Agree & check”.'],
    // WhatsApp, back since 2026-10-09 (migration 144).
    ['whatsapp_sending_enabled', 'WhatsApp: sending on (true / false)', 'The master switch. false: nothing at all is sent on WhatsApp — replies, alerts, broadcasts. Turn it off at once if anything looks wrong.'],
    ['whatsapp_marketing_per_day', 'WhatsApp: marketing messages a day (all customers)', 'At most this many MARKETING-template messages a day, and only to customers who opted in to offers (25).'],
    ['whatsapp_templates_paused_until', 'WhatsApp: templates paused until', 'Set by itself when Meta says "spam rate limit hit" (24 hours). While set, no alert, reminder or broadcast template goes; replies still go. Clear it to end the pause early.'],
    ['watch_daily_status_enabled', 'Monitoring: "today\'s update" on (true / false)', 'The status update (email, notification, SMS once approved) to everyone monitoring a vehicle, paid or free, even when nothing changed. false: they hear only when something happens.'],
    // The cadence (user, 2026-10-10: "first 7 days every day, then alternate days, then only when changes").
    ['watch_status_daily_days', 'Monitoring update: every day for the first N days', '0: counted per vehicle from the day its monitoring started; 0 = no daily stretch (2026-10-15).'],
    ['watch_status_every_days', 'Monitoring update on WhatsApp: every N days', '3: after any daily days, the WhatsApp update goes every N days (days 1, 4, 7 …). 2 = every other day.'],
    ['watch_status_email_every_days', 'Monitoring update by email and notification: every N days', '2: the same update by email and phone notification every N days (days 1, 3, 5 …) — free, so it can be more often.'],
    ['watch_status_alternate_until_day', 'Monitoring update: until day N', '28: routine updates stop after this day of monitoring; after it, only when something changes. 0 = while monitoring runs.'],
    ['sms_tpl_status', 'SMS template id: monitoring update', '3 values: vehicle, short status ("all clear", "PUC expired"), the site (sms_site_value, added by itself). 228567 = gp_vehicle_status_v1. Empty = not sent by SMS.'],
    ['watch_daily_status_every_days', 'Monitoring: "today\'s update" every N days (retired)', 'Replaced on 10 Oct 2026 by the daily / every-other-day settings above.'],
    ['whatsapp_marketing_gap_days', 'WhatsApp: days between marketing to one person', 'No second marketing message to the same customer within this many days (7).'],
    ['nudge_enabled', 'WhatsApp: remind people who said Hi to agree (true / false)', 'Off since 2026-10-09: someone who only said Hi hears from GaadiPe again only if they write.'],
    ['wa_junk_mute_after', 'WhatsApp: pause after this many meaningless messages in 10 minutes', '6. Single characters or symbols only; Hi, STOP, buttons and vehicle numbers never count. They are told once, honestly, then not answered.'],
    ['wa_junk_mute_minutes', 'WhatsApp: that pause lasts (minutes)', '60. STOP / START still work during it.'],
    ['nudge_hi_enabled','WhatsApp: one reminder to someone who said Hi but sent no vehicle number (true / false)', 'true (2026-10-25): "just send its number, like KA01AB1234" - once per person ever, inside their 24-hour window, never at night (9 pm - 8 am), never after STOP.'],
    ['nudge_hi_after_minutes', 'WhatsApp: that reminder after (minutes)', '30. At least 15.'],
    ['nudge_hi_window_hours', 'WhatsApp: that reminder only for a Hi within (hours)', '3. Older ones are left alone, so no backlog is ever sent at once.'],
    ['nudge_per_tick', 'WhatsApp reminders: at most this many every 5 minutes', '2, with a random 30–90 second gap between them. Never a burst.'],
    ['nudge_payment_enabled','WhatsApp: one reminder about an unpaid payment link (true / false)', 'true (2026-10-25): an hour after someone tapped Report and did not pay, one reminder with a Pay button - inside their 24-hour window, never at night, never after STOP, never twice.'],
    // The free check before sign-in (migrations 142–143).
    ['chat_anon_checks_per_day', 'Free check before sign-in: per browser, per day', 'How many vehicles one browser may check without signing in each day (1).'],
    ['chat_anon_checks_per_day_ip', 'Free check before sign-in: per network, per day', 'How many free checks one network address may make a day. Homes and offices share one address on Wi-Fi — 3 lets a family each try once.'],
    ['chat_anon_checks_per_hour', 'Free check before sign-in: whole site, per hour', 'A flood of free checks stops here (60).'],
    // Website + SMS (2026-10-10, migration 149).
    ['chat_anon_checks_per_day', 'Free checks before sign-in: per browser a day', '2 (migration 153): a visitor may check this many vehicles a day without signing in.'],
    ['chat_anon_checks_per_day_ip', 'Free checks before sign-in: per network a day', '2: the same limit per internet address, so clearing the browser does not reset it.'],
    ['free_checks_per_day', 'Checks after sign-in: per customer a day', '10.'],
    ['free_checks_per_day_subscriber', 'Checks a day: fleet / subscription plans', '20 (migration 211). Only GaadiPe\'s own numbers have no limit.'],
    // Migration 154 (2026-10-10).
    ['free_checks_per_month', 'Checks after sign-in: per customer a month', '30 (0 = no monthly cap). Each report bought adds the bonus below.'],
    ['checks_per_report_bonus', 'Checks added per report bought (that month)', '5: every paid report — full report or renewal — adds this many checks to the month.'],
    ['report_renewal_window_days', 'Renewal price: days after the last report ended', '30: a vehicle bought before, whose report ended within this many days, renews at the plan\'s renewal price. 0 = any time.'],
    ['free_monitor_enabled', 'Free monitoring: offered (true / false)', 'After sign-in, one vehicle monitored free — once per mobile number and per browser.'],
    ['free_monitor_days', 'Free monitoring: days', '14.'],
    ['free_monitor_notice_days', 'Free monitoring: tell them this many days before it ends', '2 — "continue for ₹19", by notification, email and SMS.'],
    ['site_session_after_monitor_days', 'Sign-in: days it lasts after monitoring ends', '7 — so the renewal reminder still opens their account without a code. Otherwise a sign-in lasts site_session_days (30) from the last visit.'],
    // 2026-10-10.
    ['site_single_session', 'Sign-in: one device at a time (true / false)', 'true: signing in ends the account\'s other sign-ins (they are told "you signed in on another device") and their notification subscriptions. false: several devices stay signed in.'],
    // (2026-10-22) The alert templates' DLT header, and the site their last value names.
    ['sms_alert_sender_id', 'SMS alerts: sender header', 'GAADIP — the header the alert templates are approved under (sign-in codes keep the .env header).'],
    ['sms_site_value', 'SMS alerts: the site in the message', 'gaadipe.in — the last value of the challan, status and monitoring-end SMS ("Full details on gaadipe.in").'],
    ['sms_alerts_enabled', 'SMS alerts and notices: on (true / false)', 'The master switch for every SMS other than sign-in codes. Each kind also needs its approved DLT template id below.'],
    ['sms_tpl_expiry', 'SMS template id: document expiry', 'Fast2SMS message id of the approved DLT template — 3 values: document, vehicle, date. Empty = not sent.'],
    ['sms_tpl_challan', 'SMS template id: new challan', '3 values: vehicle, what was found, the site (added by itself). 228568 = gp_challan_alert_v1. Empty = not sent.'],
    ['sms_tpl_monitor_end', 'SMS template id: monitoring ending', '3 values: vehicle, end date, the site (added by itself). 228569 = gp_monitor_end_v1. Empty = not sent.'],
    ['sms_tpl_service', 'SMS template id: one-time service notice', 'No values — "GaadiPe is now on gaadipe.in" (scripts/sms-notice.js). Empty = not sent.'],
    ['sms_tpl_offers', 'SMS template id: offers (promotional)', '1 value: the tip. Only to customers who opted in, 9 am – 9 pm. Empty = not sent.'],
    // Manual SMS from the web admin's SMS & notifications page (migration 155).
    ['sms_tpl_manual', 'SMS template id: manual (sent by hand)', 'The approved DLT message id. Empty = a placeholder; the page will not send it.'],
    ['sms_tpl_manual_text', 'Manual SMS: the approved wording', 'Shown beside the box when sending, e.g. "Dear customer, {#var#} - GaadiPe".'],
    ['sms_tpl_manual_vars', 'Manual SMS: how many values', 'How many {#var#} the approved template has (1).'],
    ['reach_sms_per_tick', 'Queued SMS sent per minute', '20.'],
    ['reach_push_per_tick', 'Queued notifications sent per minute', '50.'],
    // Like CarInfo (2026-10-10, migration 148).
    ['free_check_show_variant', 'Free check before sign-in: show the variant (true / false)', 'true: the full model, e.g. "SPLENDOR PLUS"; false: only the first word, the rest hidden.'],
    // ONE toggle for the owner's name (user, 2026-10-21): signed-in customers always see it.
    ['free_check_show_owner', 'Owner name before sign-in (true / false)', 'false: the owner name (masked, like R****H K***R) is shown only after the customer signs in. true: shown before AND after sign-in.'],
    // Developer tools on gaadipe.in (2026-10-25). Real protection is on the server; these deter the curious.
    ['site_devtools_pause', 'Website: pause while developer tools are open (true / false)', 'true: someone who opens F12 / DevTools sees "Close developer tools to continue" and the page stops. Ordinary customers never open them, so they never see it.'],
    ['site_devtools_block_keys', 'Website: block right-click and DevTools keys (true / false)', 'false by default: also blocks F12, Ctrl+Shift+I/J/C, Ctrl+U and right-click (not inside text boxes). It touches ordinary customers too, and anyone determined opens DevTools from the browser menu anyway.'],
    // Suspicious-activity guard (2026-10-25): sign-in codes for many different numbers from one address.
    ['site_otp_ip_numbers_per_hour', 'Sign-in codes: different numbers per device, per hour', '3: one internet address may ask for codes for at most this many different mobile numbers an hour (0 = no limit). The admin is alerted when it is hit.'],
    ['site_otp_ip_numbers_per_day', 'Sign-in codes: different numbers per device, per day', '5: the same, per day.'],
    // The GaadiPe app's dashboard (user, 2026-10-22; migration 206).
    ['free_check_show_status', 'Free check before sign-in: show each document\'s status (true / false)', 'true: Insurance, PUC, Registration, Road tax (and Fitness, Permit for commercial) as Valid / Due soon / Expired, the pending challan count and the health score — no dates. false: make and model only. Dates, challan details, loan and blacklist stay in sign-in and the ₹19 report.'],
    ['free_check_show_rto', 'Free check before sign-in: show the RTO (true / false)', 'RTO code, office, district and state — worked out from the number, free.'],
    ['free_view_detail', 'Free check after sign-in: how much it shows', 'public = the whole public record like CarInfo (every validity date, age, norms, seats, weight, RC status, how many challans) — the ₹19 report keeps the loan, blacklist/NOC, challan amounts, owners, insurer, FASTag and the verdict; labels / count / none show less.'],
    // 2026-10-25 (rcBackup.freeOpts): every free check - WhatsApp, website, before or after sign-in.
    ['free_check_paid_lookups_per_day', 'Free checks: paid RC lookups a day, everyone together', '15. Past it, free checks use only the free sources (ULIP, eChallan.app) and saved records. Paid reports are never capped.'],
    ['free_check_paid_lookups_per_person', 'Free checks: paid RC lookups a day, per person', '1. A person\'s later free checks that day use only the free sources and saved records.'],
    ['free_check_backup_per_day', 'Free check before sign-in: paid RC backup calls a day','When ULIP and eChallan.app cannot answer, a free check may use the paid RC backup (IDSPay) up to this many times a day; after that it stops at eChallan.app. 0 = never. Paid reports are not affected.'],
    // The line before a vehicle check in the chat (user, 2026-10-07).
    ['check_notice_mode', 'Check notice: on / auto / off', 'Before a visitor’s first check, and when a check fails: “Government services may be down…”. auto = only while VAHAN is down.'],
    ['check_notice_en', 'Check notice: English text', 'Empty = the built-in wording.'],
    ['check_notice_hi', 'Check notice: Hindi text', 'Empty = the built-in wording.'],
    // Broadcast room (user, 2026-10-06): the suggested daily batch.
    ['broadcast_room_buffer', 'Broadcast room: keep free (people)', 'Left out of the suggested batch for alerts and live customers. 15 by default.'],
    ['broadcast_room_gap_days', 'Broadcast room: rest days between broadcasts', 'Someone who got a broadcast this many days ago or less is not suggested again. 7 by default.'],
    ['lookup_waitlist_enabled', 'Waiting list when vehicle records are down (true / false)', 'Saves the number and sends the check automatically once the service is back.'],
    ['admin_whatsapp_numbers', 'Daily summary to these WhatsApp numbers', 'Your own number(s), comma-separated. Sent only if that number messaged the bot in the last 24 hours.'],
    ['admin_whatsapp_summary_hour_ist', 'Daily summary time (IST, like 23:55)', 'A time, or just an hour: 21 = 9 pm.'],
    // 2026-10-25: "you can also include web customers, but distinguish them".
    ['admin_whatsapp_shows_all', 'WhatsApp admin: count website customers too (true / false)', 'true (default) = every customer who agreed, WhatsApp or website, each marked where they agreed. false = WhatsApp only, as before.'],
  ]],
  // The paid RC backup when ULIP's VAHAN fails (user, 2026-10-02; switch: Feature flags → RC backup).
  ['RC backup provider', [
    // Way2API, asked before IDSPay (user, 2026-10-21; vehicle/way2api.js, key WAYTWOAPI_KEY in .env).
    ['way2api_balance_usd', 'Way2API balance now (US dollars) — update after every recharge', 'Type the wallet balance Way2API shows, in dollars: 10.00. Each charged call takes way2api_cost_usd off. Below one call’s price, IDSPay answers instead. Blank = not tracked.'],
    ['way2api_enabled', 'Use Way2API before IDSPay (true / false)', 'true = ULIP → eChallan.app → Way2API (≈ ₹2.40) → IDSPay (₹2.95). false = straight to IDSPay.'],
    ['way2api_cost_usd', 'Way2API cost per call with GST (US dollars)', '0.0254 = $0.0215 + 18% GST. Taken off the balance on every charged call.'],
    ['way2api_cost_paise', 'Way2API cost per call (paise)', '240 = ₹2.40 (0.0254 × ₹94.3). Used in the money reports.'],
    ['way2api_low_balance_usd', 'Way2API: warn when the balance falls to (US dollars)', '1 = $1. At or below it: an email once a day.'],
    ['way2api_daily_limit', 'Way2API: most calls per day', 'Past it, IDSPay is asked until midnight. 300 by default.'],
    // After a recharge (user, 2026-10-20: "an option to update what I recharged to IDSPay").
    ['rc_backup_balance_paise', 'IDSPay balance now (paise) — update after every recharge', 'Type the balance IDSPay shows, in paise: ₹1,500 = 150000. Each call takes its cost off; IDSPay’s own figure replaces it when it sends one. Blank = not tracked. Shown in the server log on every call.'],
    ['rc_backup_low_balance_paise', 'Warn when the balance falls to (paise)', '5000 = ₹50. At or below it: an email once a day, and free checks stop using IDSPay so the rest serves paying customers.'],
    ['rc_backup_paid_only', 'IDSPay only for paid reports (true / false)', 'false = free checks use IDSPay too (ULIP has no RC for private vehicles). Set back to false after recharging if the low balance turned it on.'],
    ['rc_backup_cost_paise', 'Cost per call before GST (paise)', '250 = ₹2.50, which is ₹2.95 with GST. Used in the money reports and the balance.'],
    ['rc_backup_daily_limit', 'Most calls per day', 'Past it, ULIP’s failure stands until midnight. 300 calls ≈ ₹885.'],
    ['free_check_backup_per_day', 'Website checks before sign-in: IDSPay calls per day', 'The first free checks on gaadipe.in, before sign-in. 100 by default; past it they stop at eChallan.app.'],
    ['rc_owner_refresh_hours', 'Paying customer’s own vehicle: refresh at most every (hours)', 'Re-checked or its report opened: a fresh RC at most this often. 24 by default.'],
    ['rc_confirm_days', 'Before an expiry alert: refresh at most every (days)', 'So a renewed PUC or insurance is seen before warning. 3 by default.'],
    ['ulip_vahan_second_format', 'Also try ULIP VAHAN/01 when VAHAN/04 has no data (true / false)', 'false = one ULIP call, then eChallan.app and IDSPay.'],
  ]],
  // The free second source (2026-10-05); may start charging ₹1 a call (2026-10-08).
  ['eChallan.app (second RC source)', [
    ['echallan_app_enabled', 'Use eChallan.app when ULIP fails (true / false)', 'Tried after ULIP and before IDSPay. Its “pending verification” answers cost nothing.'],
    ['echallan_app_paid_only', 'Only for paid reports (true / false)', 'Turn on when eChallan.app starts charging: free checks and background jobs then stop at ULIP. Off while the sponsored credits last.'],
    ['echallan_app_low_credits', 'Warn when credits fall to', 'A ping when the remaining credits reach this number. 500 by default.'],
  ]],
  // The Saturday money report (user, 2026-10-01).
  ['Weekly money report (Excel by email)', [
    ['finance_weekly_email', 'Send it (true / false)', 'Every week, the Excel of the week just ended.'],
    ['finance_report_emails', 'Send to', 'One or more addresses, separated by commas.'],
    ['finance_weekly_day', 'Day (0 = Sunday … 6 = Saturday)', 'The week reported is the seven days before that day.'],
    ['finance_weekly_hour_ist', 'From hour (IST, 0–23)', ''],
  ]],
];

const HISTORY_ACTIONS = ['settings_changed', 'plan_changed', 'plan_updated', 'gst_rate_changed', 'flag_changed', 'alert_muted', 'alert_unmuted'];

async function overview() {
  const keys = GROUPS.flatMap(([, items]) => items.map(([k]) => k));
  const [vals, plans, gst, history] = await Promise.all([
    db.query(`SELECT key, value, modified_at FROM app_settings WHERE key = ANY($1)`, [keys]),
    db.query(`SELECT code, name, kind, price_paise, is_active FROM plans ORDER BY is_active DESC, id`).catch(() => ({ rows: [] })),
    db.query(`SELECT id, percent, effective_from, effective_to, is_active FROM gst_percentages ORDER BY effective_from DESC NULLS LAST, id DESC`),
    db.query(`SELECT x.id, x.action, x.detail, x.created_at, a.name AS admin FROM admin_audit x LEFT JOIN admin_users a ON a.id = x.admin_id
               WHERE x.action = ANY($1) ORDER BY x.id DESC LIMIT 100`, [HISTORY_ACTIONS]),
  ]);
  const v = Object.fromEntries(vals.rows.map((r) => [r.key, r]));
  return {
    plans: plans.rows, gst: gst.rows.map((g) => ({ ...g, id: String(g.id), percent: Number(g.percent) })),
    groups: GROUPS.map(([title, items]) => ({ title, items: items.map(([key, label, note]) => ({
      key, label, note: note || null, value: v[key]?.value ?? null, exists: Boolean(v[key]), modified_at: v[key]?.modified_at || null })) })),
    history: history.rows.map((h) => ({ id: String(h.id), action: h.action, admin: h.admin, at: h.created_at, changes: changesOf(h) })),
    notes: { referral: 'Referral settings are not shown — GaadiPe has no referral programme for now.' },
  };
}

/* "Report price ₹19 → ₹29" — before and after, from each kind of audit entry. */
function changesOf(h) {
  const d = h.detail || {};
  if (h.action === 'settings_changed') {
    return Object.entries(d.changes || {}).map(([k, after]) => ({ what: k, before: d.was?.[k] ?? null, after: String(after) }));
  }
  if (d.before !== undefined || d.after !== undefined) {
    const b = d.before || {}; const a = d.after || {};
    if (typeof b === 'object' && typeof a === 'object') {
      return [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
        .map((k) => ({ what: `${d.code || d.flag || d.rule || ''}${d.code || d.flag || d.rule ? ' · ' : ''}${k}`, before: b[k] ?? null, after: a[k] ?? null }));
    }
    return [{ what: d.flag || d.rule || d.code || h.action, before: String(b), after: String(a) }];
  }
  return [{ what: h.action.replace(/_/g, ' '), before: null, after: JSON.stringify(d).slice(0, 120) }];
}

async function setGst({ percent, from }) {
  const p = Number(percent);
  if (!Number.isFinite(p) || p < 0 || p > 40) return { ok: false, message: 'Give a GST rate between 0 and 40%.' };
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? from : new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const before = await db.one(`SELECT percent, effective_from FROM gst_percentages WHERE is_active ORDER BY effective_from DESC NULLS LAST LIMIT 1`);
  await db.tx(async (c) => {
    await c.query(`UPDATE gst_percentages SET effective_to = ($1::date - 1) WHERE is_active AND effective_to IS NULL AND (effective_from IS NULL OR effective_from < $1::date)`, [day]);
    await c.query(`INSERT INTO gst_percentages (percent, effective_from, is_active) VALUES ($1, $2, true)`, [p, day]);
  });
  return { ok: true, before: before ? Number(before.percent) : null, after: p, from: day };
}

async function flags() {
  const v = await flagsMod.all();
  return { rows: Object.entries(flagsMod.FLAGS).map(([name, f]) => ({ name, label: f.label, about: f.about, danger: f.danger, on: v[name] })) };
}

async function setFlag(name, on) {
  const f = flagsMod.FLAGS[name];
  if (!f) return { ok: false, message: 'No such switch.' };
  const before = (await flagsMod.all())[name];
  await db.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`,
    [f.key, on ? 'true' : 'false']);
  settings.refresh(); flagsMod.forget();
  return { ok: true, before, after: Boolean(on), label: f.label };
}

/* ─────────────────────────────── alert rules ─────────────────────────────── */

const RULES = [
  ['records_api_down', 'Vehicle API unavailable', 'critical', 'Half or more records-API calls failed in 15 minutes.', []],
  ['records_api_errors', 'Vehicle API errors', 'warning', 'Records-API failures above the threshold in 15 minutes.', [['alert_api_error_pct', 'Error rate above (%)']]],
  ['records_api_slow', 'Vehicle API slow', 'warning', 'The slowest 5% of calls above the threshold over 30 minutes.', [['alert_api_p95_ms', 'P95 latency above (ms)']]],
  ['whatsapp_failures', 'WhatsApp failures', 'warning', 'Failed sends above the threshold in an hour (5+ sent).', [['alert_wa_failure_pct', 'Failure rate above (%)']]],
  ['payment_failures', 'Payment failures', 'warning', 'Payments with a failed attempt in the last hour.', [['alert_payment_failures_hour', 'Failed payments per hour']]],
  ['reports_missing', 'Paid reports not generated', 'critical', 'A paid report older than 10 minutes with no report.', []],
  ['email_failing', 'Admin emails failing', 'warning', 'Three or more admin emails gave up in 24 hours.', []],
  ['job_late', 'Background job missed', 'warning', 'A job skipped two of its own intervals.', []],
  ['payment_recon_mismatch', 'Payment reconciliation mismatch', 'warning', 'The daily reconciliation found something to review.', []],
  ['disk_high', 'Disk usage high', 'warning', 'Disk use at or above the threshold.', [['alert_disk_pct', 'Disk used above (%)']]],
  ['memory_high', 'Server memory high', 'warning', 'Memory use at or above the threshold.', [['alert_memory_pct', 'Memory used above (%)']]],
  ['ssl_expiring', 'SSL certificate expiring', 'warning', 'The site certificate expires within the threshold.', [['alert_ssl_days', 'Days before expiry']]],
  ['domain_expiring', 'Domain expiring', 'warning', 'The domain registration expires within the threshold.', [['alert_domain_days', 'Days before expiry']]],
  ['backup_failed', 'Backup failed', 'critical', 'The last backup attempt failed.', []],
  ['backup_stale', 'Backup stale', 'warning', 'No backup within the threshold.', [['alert_backup_stale_hours', 'Hours without a backup']]],
  ['traffic_spike', 'Traffic spike', 'info', 'Website visitors in an hour above the 7-day hourly average by the threshold.', [['alert_traffic_spike_pct', 'Above the average by (%)']]],
  ['revenue_target', 'Revenue target reached', 'success', 'Today’s revenue crossed the target (0 = off).', [['alert_daily_revenue_target_paise', 'Daily target (paise)']]],
  // The website (2026-10-07, the web admin's anomaly detection).
  ['web_otp_failing', 'Sign-in codes not working', 'critical', 'Few of the sign-in codes sent in 30 minutes led to a sign-in (5+ sent) — SMS may not be arriving.', [['alert_otp_success_pct', 'Sign-ins per code below (%)']]],
  ['web_free_checks_failing', 'Free checks failing', 'warning', 'Most free chat checks in 30 minutes found nothing or failed (5+ checks).', [['alert_free_check_fail_pct', 'Failed above (%)']]],
  ['traffic_drop', 'Traffic drop', 'warning', 'Website visitors in an hour below the 7-day hourly average by the threshold (average 10+).', [['alert_traffic_drop_pct', 'Below the average by (%)']]],
  ['conversion_drop', 'Conversion drop', 'warning', 'Today’s visitors who paid, against the last 7 days (50+ visitors today).', [['alert_conversion_drop_pct', 'Below the 7-day rate by (%)']]],
  ['web_stuck_at_payment', 'Customers waiting at payment', 'info', 'Visitors on the ₹19 payment step with no action for 5 minutes.', [['alert_stuck_payment_count', 'At least this many']]],
];

let muteCache = { at: 0, v: {} };
async function muted() {
  if (Date.now() - muteCache.at < 15000) return muteCache.v;
  let v = {};
  try { v = JSON.parse(await settings.get('alerts_muted', '{}') || '{}'); } catch { v = {}; }
  muteCache = { at: Date.now(), v };
  return v;
}
/** Is this alert (or its rule — "job_late" covers "job_late:watch") muted now? */
async function isMuted(key) {
  const m = await muted(); const rule = String(key).split(':')[0];
  return [key, rule].some((k) => m[k] && new Date(m[k]) > new Date());
}

async function rules() {
  const [m, open] = await Promise.all([muted(), db.query(`SELECT split_part(rule_key, ':', 1) AS rule, count(*)::int AS n FROM admin_alerts WHERE status <> 'resolved' GROUP BY 1`)]);
  const keys = RULES.flatMap((r) => r[4].map(([k]) => k));
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [keys]);
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const openBy = Object.fromEntries(open.rows.map((r) => [r.rule, r.n]));
  return {
    enabled: String(await settings.get('alerts_enabled', 'true')) !== 'false',
    rows: RULES.map(([key, label, severity, about, th]) => ({
      key, label, severity, about, open: openBy[key] || 0,
      muted_until: m[key] && new Date(m[key]) > new Date() ? m[key] : null,
      thresholds: th.map(([k, l]) => ({ key: k, label: l, value: v[k] ?? null })),
    })),
  };
}

async function mute(rule, hours) {
  if (!RULES.some((r) => r[0] === rule)) return { ok: false, message: 'No such rule.' };
  const m = { ...(await muted()) };
  const before = m[rule] || null;
  if (hours > 0) m[rule] = new Date(Date.now() + Math.min(24 * 30, hours) * 3600e3).toISOString(); else delete m[rule];
  for (const [k, until] of Object.entries(m)) if (new Date(until) <= new Date()) delete m[k];
  await db.query(`INSERT INTO app_settings (key, value) VALUES ('alerts_muted', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [JSON.stringify(m)]);
  settings.refresh(); muteCache.at = 0;
  return { ok: true, before, after: m[rule] || null };
}

module.exports = { overview, setGst, flags, setFlag, rules, mute, isMuted, RULES };
