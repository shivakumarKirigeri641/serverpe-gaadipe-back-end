/**
 * src/admin/journey.js — one person, start to finish, and the CSV exports
 * (user, 2026-09-25, command center phase 3).
 * ---------------------------------------------------------------------------
 *   journey({ mobile | userId | visitorId })
 *       Everything known about one person as one timeline: their website
 *       visits (through every browser linked to them), each WhatsApp message
 *       both ways, each step, lookup, API call, payment and report — with who
 *       they are, where they first and last came from, and what converted.
 *
 *   exportCsv(kind, { from, to })
 *       customers · events · payments · searches · api · whatsapp, as CSV.
 *
 * A person can be known three ways — a browser before they write, a mobile
 * once they write, a customer id once there is a row — so the journey starts
 * from whichever it is given and gathers the other two.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');

const local10 = (m) => {
  const d = String(m || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? d : null;
};

const WORDS = {
  session_started: 'Visit started', page_view: 'Page viewed', whatsapp_cta_clicked: 'Tapped a WhatsApp button',
  whatsapp_chat_started: 'First WhatsApp message', whatsapp_greeting: 'Said Hi', terms_accepted: 'Agreed to the terms',
  whatsapp_vehicle_received: 'Sent a vehicle number', vehicle_api_success: 'Records API answered',
  vehicle_api_failed: 'Records API failed', vehicle_search_success: 'Vehicle details shown',
  vehicle_search_failed: 'Vehicle not found', report_preview_viewed: 'Tapped the full report',
  payment_started: 'Payment link sent', payment_page_viewed: 'Opened the payment page',
  payment_success: 'Payment received', report_generated: 'Report generated', report_delivered: 'Report delivered',
  whatsapp_linked_to_web: 'Chat joined to a website visit', whatsapp_ad_clicked: 'Came from a WhatsApp ad',
  whatsapp_opt_out: 'Replied STOP', whatsapp_opt_in: 'Replied START',
};

/** Who this is, by any of the three handles. */
async function identify({ mobile, userId, visitorId }) {
  let m = local10(mobile);
  let uid = /^\d+$/.test(String(userId || '')) ? String(userId) : null;
  const vid = /^[A-Za-z0-9_-]{8,64}$/.test(String(visitorId || '')) ? String(visitorId) : null;

  if (!m && vid) m = (await db.one(`SELECT mobile FROM visitors WHERE visitor_id = $1`, [vid]))?.mobile || null;
  if (!m && uid) m = (await db.one(`SELECT mobile FROM users WHERE id = $1`, [uid]))?.mobile || null;
  const user = m ? await db.one(`SELECT * FROM users WHERE mobile = $1`, [m])
    : uid ? await db.one(`SELECT * FROM users WHERE id = $1`, [uid]) : null;
  if (user) uid = String(user.id);
  const session = m ? await db.one(`SELECT * FROM whatsapp_sessions WHERE mobile = $1`, [m]) : null;

  // Every browser tied to them: by mobile, by customer, the chat's own, or the one asked for.
  const { rows: visitors } = await db.query(
    `SELECT * FROM visitors
      WHERE ($1::text IS NOT NULL AND mobile = $1)
         OR ($2::bigint IS NOT NULL AND user_id = $2)
         OR visitor_id = ANY($3::text[])
      ORDER BY first_seen_at`,
    [m, uid, [session?.visitor_id, vid].filter(Boolean)]);
  return { mobile: m, userId: uid, user, session, visitors };
}

async function journey(q) {
  const who = await identify(q);
  // A number GaadiPe has never heard from is not a person with an empty past.
  if (!who.user && !who.session && !who.visitors.length) return { found: false };
  const vids = who.visitors.map((v) => v.visitor_id);

  const [events, messages, money] = await Promise.all([
    db.query(
      `SELECT e.*, p.status AS payment_status, p.payment_id AS razorpay_payment_id
         FROM events e LEFT JOIN payments p ON p.id = e.payment_id
        WHERE (($1::text IS NOT NULL AND e.mobile = $1)
            OR ($2::bigint IS NOT NULL AND e.user_id = $2)
            OR e.visitor_id = ANY($3::text[]))
          -- The messages themselves are shown below, with their words.
          AND e.name <> 'whatsapp_message_received'
        ORDER BY e.occurred_at, e.id LIMIT 2000`,
      [who.mobile, who.userId, vids]),
    who.mobile ? db.query(
      `SELECT id, created_at, direction, message_type, body, template_name, error_message
         FROM whatsapp_messages WHERE mobile = $1 ORDER BY id LIMIT 2000`, [who.mobile]) : { rows: [] },
    who.userId ? db.one(
      `SELECT coalesce(sum(amount_paise) FILTER (WHERE status = 'paid'), 0)::int AS spent_paise,
              count(*) FILTER (WHERE status = 'paid')::int AS payments,
              count(*) FILTER (WHERE status = 'created' AND created_at < now() - interval '30 minutes')::int AS unfinished,
              (SELECT count(*)::int FROM vehicle_reports r WHERE r.user_id = $1) AS reports,
              (SELECT count(*)::int FROM user_vehicles uv WHERE uv.user_id = $1) AS vehicles
         FROM payments WHERE user_id = $1`, [who.userId]) : null,
  ]);

  const items = [
    ...events.rows.map((e) => ({
      at: e.occurred_at, kind: 'event', name: e.name, words: WORDS[e.name] || e.name.replace(/_/g, ' '),
      channel: e.channel, status: e.status, error_code: e.error_code, reg_no: e.reg_no,
      amount_paise: e.amount_paise, duration_ms: e.duration_ms, source: e.source, campaign: e.campaign,
      page: e.page, payment_id: e.payment_id ? String(e.payment_id) : null,
      payment_status: e.payment_status || null, razorpay_payment_id: e.razorpay_payment_id || null,
      visitor_id: e.visitor_id, meta: e.metadata,
    })),
    ...messages.rows.map((m) => ({
      at: m.created_at, kind: 'message', direction: m.direction, channel: 'whatsapp',
      words: m.direction === 'in' ? 'Customer wrote' : m.template_name ? `GaadiPe sent template ${m.template_name}` : 'GaadiPe replied',
      body: m.body, message_type: m.message_type, status: m.error_message ? 'failed' : 'ok', error_code: m.error_message,
    })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  // Where they came from: the first and the latest outside touch, and what converted.
  const touches = [];
  for (const v of who.visitors) {
    if (v.first_touch?.source) touches.push({ at: v.first_seen_at, channel: 'website', ...v.first_touch });
    if (v.last_touch?.source) touches.push({ at: v.last_seen_at, channel: 'website', ...v.last_touch });
  }
  const attr = who.session?.attribution || {};
  if (attr.channel === 'whatsapp_ad') {
    touches.push({ at: who.session.created_at, channel: 'whatsapp_ad', source: 'meta_ads', campaign: attr.headline || attr.source_id });
  }
  // No website visit and no ad: they found the number themselves — from their
  // first appearance anywhere, which can predate the current chat row.
  if (!touches.length && (who.session || who.user)) {
    const first = [who.user?.created_at, who.session?.created_at].filter(Boolean).map((d) => new Date(d)).sort((a, b) => a - b)[0];
    touches.push({ at: first, channel: who.user?.signup_channel === 'web' ? 'website' : 'whatsapp',
                   source: who.user?.signup_channel === 'web' ? 'website_signup' : 'whatsapp_direct' });
  }
  touches.sort((a, b) => new Date(a.at) - new Date(b.at));
  const paidAt = items.find((i) => i.name === 'payment_success');

  const place = who.visitors.find((v) => v.place?.city || v.place?.region)?.place || null;
  const device = who.visitors.find((v) => v.device?.device_type)?.device || null;
  const times = items.map((i) => new Date(i.at).getTime());

  return {
    found: true,
    profile: {
      mobile: who.mobile, user_id: who.userId,
      name: who.user?.display_name || who.user?.wa_profile_name || who.session?.profile_name || null,
      first_seen: times.length ? new Date(Math.min(...times)) : who.user?.created_at || null,
      last_active: times.length ? new Date(Math.max(...times)) : null,
      in_window: who.session?.last_inbound_at ? Date.now() - new Date(who.session.last_inbound_at) < 24 * 3600e3 : false,
      opted_out: !!who.session?.wa_opt_out_at,
      state: who.session?.state || null,
      visitors: vids,
      place, device,
      ...(money || { spent_paise: 0, payments: 0, unfinished: 0, reports: 0, vehicles: 0 }),
    },
    attribution: {
      first_touch: touches[0] || null,
      last_touch: touches.length ? touches[touches.length - 1] : null,
      conversion: paidAt ? { at: paidAt.at, channel: paidAt.channel === 'web' ? 'website' : 'whatsapp' } : null,
    },
    items,
  };
}

/* ────────────────────────────────── exports ─────────────────────────────── */

/*
 * One CSV cell. Quoted when it must be; and a leading = + - @ is defused with
 * an apostrophe, because a spreadsheet would otherwise run a customer's text
 * as a formula (CSV injection).
 */
function cell(v) {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (rows) => {
  if (!rows.length) return 'no rows\n';
  const cols = Object.keys(rows[0]);
  return `${cols.join(',')}\n${rows.map((r) => cols.map((c) => cell(r[c])).join(',')).join('\n')}\n`;
};

const EXPORTS = {
  customers: `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.signup_channel,
                     u.created_at AS first_seen, u.last_seen_at AS last_active,
                     (SELECT count(*) FROM user_vehicles uv WHERE uv.user_id = u.id) AS vehicles,
                     (SELECT count(*) FROM vehicle_reports r WHERE r.user_id = u.id) AS reports,
                     (SELECT coalesce(sum(amount_paise), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') / 100.0 AS spent_rupees,
                     (SELECT count(*) FROM whatsapp_messages w WHERE w.mobile = u.mobile) AS whatsapp_messages,
                     coalesce((SELECT v.first_touch->>'source' FROM visitors v WHERE v.mobile = u.mobile ORDER BY v.first_seen_at LIMIT 1),
                              (SELECT s.attribution->>'channel' FROM whatsapp_sessions s WHERE s.mobile = u.mobile)) AS first_source
                FROM users u WHERE u.deactivated_at IS NULL AND u.created_at >= $1 AND u.created_at < $2 ORDER BY u.id`,
  events: `SELECT id, occurred_at, name, channel, mobile, user_id, visitor_id, session_id, reg_no, payment_id,
                  source, campaign, page, status, error_code, duration_ms, amount_paise
             FROM events WHERE occurred_at >= $1 AND occurred_at < $2 ORDER BY occurred_at`,
  payments: `SELECT p.id, p.created_at, p.paid_at, p.status, p.amount_paise / 100.0 AS amount_rupees, u.mobile,
                    p.raw->>'reg_no' AS reg_no, p.order_id, p.payment_id AS razorpay_payment_id, p.gateway
               FROM payments p LEFT JOIN users u ON u.id = p.user_id
              WHERE p.created_at >= $1 AND p.created_at < $2 ORDER BY p.created_at`,
  searches: `SELECT e.occurred_at, e.name AS result, coalesce(e.mobile, u.mobile) AS mobile, e.reg_no,
                    v.maker, v.model, v.fuel, v.vehicle_class, e.error_code
               FROM events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN vehicles v ON v.reg_no = e.reg_no
              WHERE e.name IN ('vehicle_search_success', 'vehicle_search_failed')
                AND e.occurred_at >= $1 AND e.occurred_at < $2 ORDER BY e.occurred_at`,
  api: `SELECT id, created_at, dataset, provider_path, reg_no, cache_hit, ok, outcome, http_status, error_code,
               error_message, duration_ms, cost_paise
          FROM api_calls WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at`,
  whatsapp: `SELECT id, created_at, mobile, direction, message_type, template_name, body, error_message
               FROM whatsapp_messages WHERE created_at >= $1 AND created_at < $2 ORDER BY id`,
};

async function exportCsv(kind, { from, to } = {}) {
  const sql = EXPORTS[kind];
  if (!sql) return null;
  const day = (s, end) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
    ? new Date(Date.parse(`${s}T00:00:00Z`) - 330 * 60000 + (end ? 24 * 3600e3 : 0)) : null);
  const a = day(from) || new Date(0);
  const b = day(to, true) || new Date(Date.now() + 60000);
  const { rows } = await db.query(sql, [a, b]);
  return { csv: toCsv(rows), rows: rows.length };
}

module.exports = { journey, exportCsv, EXPORT_KINDS: Object.keys(EXPORTS) };
