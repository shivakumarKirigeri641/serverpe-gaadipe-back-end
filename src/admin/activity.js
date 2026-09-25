/**
 * src/admin/activity.js — Live Activity and the Notification Center (user,
 * 2026-09-25, operations module phase 7).
 * ---------------------------------------------------------------------------
 *   stream({since})    everything happening, newest first: website visits,
 *                      vehicle searches, WhatsApp chats, lookups, reports,
 *                      payments, and records-API errors. The screen asks for
 *                      what came after its cursor, so the cost does not grow.
 *   notifications(a)   the header's bell: alerts (critical, payment, API,
 *                      system), each linking to what it is about, and how many
 *                      this admin has not seen yet. markRead(a) moves their
 *                      "seen up to" mark (admin_preferences).
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const plate = require('../util/plate');

const WORD = {
  session_started: 'Website visit', page_view: 'Page viewed', whatsapp_cta_clicked: 'WhatsApp button clicked',
  whatsapp_chat_started: 'New WhatsApp chat', whatsapp_message_received: 'WhatsApp message', whatsapp_vehicle_received: 'Vehicle search (WhatsApp)',
  vehicle_search_success: 'Vehicle lookup — found', vehicle_search_failed: 'Vehicle lookup — not found',
  vehicle_api_success: 'Vehicle API success', report_preview_viewed: 'Full report requested', report_generated: 'Report generated',
  report_delivered: 'Report delivered', payment_started: 'Payment started', payment_page_viewed: 'Payment page opened',
  payment_success: 'Payment success', payment_failed: 'Payment failed', terms_accepted: 'Terms accepted',
};
const KIND = (n) => (/^payment/.test(n) ? 'payment' : /^report/.test(n) ? 'report' : /^vehicle/.test(n) ? 'lookup'
  : /^whatsapp|terms/.test(n) ? 'whatsapp' : 'website');

const mask = (m) => { const d = String(m || '').replace(/\D/g, ''); return d.length >= 10 ? `XXXXXX${d.slice(-4)}` : null; };

async function stream({ since } = {}) {
  const [a, b] = String(since || '0:0').split(':').map((x) => Number(x) || 0);
  const [ev, api] = await Promise.all([
    db.query(`SELECT id, occurred_at, name, channel, reg_no, mobile, amount_paise, status, duration_ms, source
                FROM events WHERE id > $1 AND occurred_at > now() - interval '24 hours'
                 AND name NOT IN ('page_view') ORDER BY id DESC LIMIT 80`, [a]),
    db.query(`SELECT id, created_at, reg_no, provider_path, error_code, outcome FROM api_calls
               WHERE id > $1 AND NOT ok AND created_at > now() - interval '24 hours' ORDER BY id DESC LIMIT 20`, [b]),
  ]);
  const rows = [
    ...ev.rows.map((e) => ({ id: `e${e.id}`, at: e.occurred_at, kind: KIND(e.name), label: WORD[e.name] || e.name.replace(/_/g, ' '),
      channel: e.channel, reg_no: e.reg_no, display: e.reg_no ? plate.pretty(e.reg_no) : null, customer: mask(e.mobile),
      amount_paise: e.amount_paise, duration_ms: e.duration_ms, status: e.status, source: e.source })),
    ...api.rows.map((x) => ({ id: `a${x.id}`, at: x.created_at, kind: 'api_error', label: 'Vehicle API error',
      reg_no: x.reg_no, display: x.reg_no ? plate.pretty(x.reg_no) : null, status: x.error_code || x.outcome, detail: x.provider_path })),
  ].sort((p, q) => new Date(q.at) - new Date(p.at));
  const maxE = Math.max(a, ...ev.rows.map((e) => Number(e.id)));
  const maxA = Math.max(b, ...api.rows.map((x) => Number(x.id)));
  return { cursor: `${maxE}:${maxA}`, rows };
}

/* Where an alert leads. */
function linkOf(al) {
  if (al.detail?.to) return al.detail.to;
  const k = al.rule_key;
  if (k.startsWith('payment_recon')) return '/payments/reconciliation';
  return { payments: '/payments/failures', records_api: '/api-providers', whatsapp: '/whatsapp', jobs: '/jobs', infrastructure: '/infrastructure',
    backups: '/backups', reports: '/documents', traffic: '/', revenue: '/profitability', email: '/health' }[al.source] || '/alerts';
}
const GROUP = (al) => (al.severity === 'critical' ? 'critical' : al.source === 'payments' || al.rule_key.startsWith('payment') ? 'payment'
  : al.source === 'records_api' ? 'api' : ['jobs', 'infrastructure', 'backups', 'email', 'reports'].includes(al.source) ? 'system' : 'other');

async function notifications(admin) {
  const pref = await db.one(`SELECT value FROM admin_preferences WHERE admin_id = $1 AND key = 'notifications.read_at'`, [admin.id]);
  const readAt = pref?.value?.at ? new Date(pref.value.at) : new Date(0);
  const { rows } = await db.query(
    `SELECT id, rule_key, severity, source, title, description, detail, status, created_at, last_seen_at
       FROM admin_alerts WHERE status <> 'resolved' OR created_at > now() - interval '3 days'
      ORDER BY (status <> 'resolved') DESC, last_seen_at DESC LIMIT 40`);
  const items = rows.map((al) => ({
    id: String(al.id), title: al.title, text: al.description, severity: al.severity, group: GROUP(al), status: al.status,
    at: al.last_seen_at || al.created_at, to: linkOf(al), unread: new Date(al.last_seen_at || al.created_at) > readAt,
  }));
  return { unread: items.filter((i) => i.unread).length, read_at: readAt, items };
}

async function markRead(admin) {
  await db.query(`INSERT INTO admin_preferences (admin_id, key, value) VALUES ($1, 'notifications.read_at', $2)
                  ON CONFLICT (admin_id, key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`,
  [admin.id, JSON.stringify({ at: new Date().toISOString() })]);
  return { ok: true };
}

module.exports = { stream, notifications, markRead };
