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
