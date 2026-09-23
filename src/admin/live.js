/**
 * src/admin/live.js — what is happening right now.
 *
 * The panel polls this every few seconds, so everything here is written to be
 * cheap and to answer the same question twice without doing the work twice:
 * `since` is a message id, not a timestamp, because ids are exact where clocks
 * and ties are not — two messages in the same millisecond would otherwise be
 * seen once and then missed.
 *
 * WHAT COUNTS AS LIVE: someone whose last inbound message is inside the 24-hour
 * window, because that is exactly the period in which GaadiPe can answer them
 * freely. Beyond it the conversation is history, not a conversation.
 */

const db = require('../db');

/** One line per conversation, newest first: who, where they are, what they said. */
async function conversations({ limit = 60, activeMinutes = null, q = '' } = {}) {
  const term = String(q || '').trim();
  const digits = term.replace(/\D/g, '');

  const { rows } = await db.query(
    `SELECT s.id, s.mobile, s.profile_name, s.state, s.state_reason,
            s.last_inbound_at, s.last_outbound_at, s.context,
            u.id AS user_id, u.wa_profile_name, u.is_paused, u.is_internal,
            (s.last_inbound_at > now() - interval '24 hours') AS in_window,
            (SELECT count(*) FROM whatsapp_messages m WHERE m.mobile = s.mobile) AS messages,
            (SELECT m.body FROM whatsapp_messages m
              WHERE m.mobile = s.mobile ORDER BY m.id DESC LIMIT 1)   AS last_body,
            (SELECT m.direction FROM whatsapp_messages m
              WHERE m.mobile = s.mobile ORDER BY m.id DESC LIMIT 1)   AS last_direction,
            (SELECT max(m.id) FROM whatsapp_messages m WHERE m.mobile = s.mobile) AS last_message_id,
            EXISTS (SELECT 1 FROM blocks b WHERE b.kind = 'mobile'
                      AND b.value = s.mobile AND b.released_at IS NULL) AS blocked,
            EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') AS has_paid
       FROM whatsapp_sessions s
       LEFT JOIN users u ON u.mobile = s.mobile
      WHERE ($1 = '' OR s.mobile LIKE '%' || $2 || '%' OR s.profile_name ILIKE '%' || $1 || '%')
        AND ($3::int IS NULL OR s.last_inbound_at > now() - ($3 || ' minutes')::interval)
      ORDER BY greatest(coalesce(s.last_inbound_at, s.created_at),
                        coalesce(s.last_outbound_at, s.created_at)) DESC
      LIMIT $4`,
    [term, digits, activeMinutes, Math.min(200, limit)]);

  return rows.map(r => ({
    ...r,
    id: String(r.id),
    user_id: r.user_id ? String(r.user_id) : null,
    messages: Number(r.messages || 0),
    last_message_id: r.last_message_id ? String(r.last_message_id) : null,
  }));
}

/** The whole thread with one person, oldest first — how a chat is read. */
async function thread(mobile, { limit = 200 } = {}) {
  const m = String(mobile || '').replace(/\D/g, '').slice(-10);
  const { rows } = await db.query(
    `SELECT id, direction, message_type, body, template_name, wa_message_id,
            error_message, created_at
       FROM (SELECT * FROM whatsapp_messages WHERE mobile = $1
              ORDER BY id DESC LIMIT $2) t
      ORDER BY id`, [m, Math.min(500, limit)]);

  const statuses = await db.query(
    `SELECT wa_message_id, status, error_code, error_title, created_at
       FROM whatsapp_status_logs WHERE mobile = $1
      ORDER BY id DESC LIMIT 200`, [m]);

  // Delivery state belongs on the message it describes, not in a second list
  // the reader has to join up by eye.
  const latest = new Map();
  for (const s of statuses.rows) {
    if (!latest.has(s.wa_message_id)) latest.set(s.wa_message_id, s);
  }

  return rows.map(r => ({
    ...r,
    id: String(r.id),
    delivery: r.wa_message_id ? latest.get(r.wa_message_id) || null : null,
  }));
}

/**
 * The heartbeat the panel polls.
 *
 * Returns only what changed since the caller's last id, plus the few counters
 * the header shows. Deliberately small: this runs every few seconds all day.
 */
async function pulse({ sinceMessageId = null } = {}) {
  const since = sinceMessageId && /^\d+$/.test(String(sinceMessageId))
    ? String(sinceMessageId) : null;

  const { rows } = await db.query(
    `SELECT m.id, m.mobile, m.direction, m.message_type, m.body, m.error_message,
            m.created_at, s.profile_name, s.state
       FROM whatsapp_messages m
       LEFT JOIN whatsapp_sessions s ON s.mobile = m.mobile
      WHERE ($1::bigint IS NULL OR m.id > $1::bigint)
      ORDER BY m.id DESC LIMIT 40`, [since]);

  const counts = await db.one(
    `SELECT
       (SELECT max(id) FROM whatsapp_messages)                          AS last_message_id,
       (SELECT count(*) FROM whatsapp_sessions
         WHERE last_inbound_at > now() - interval '15 minutes')         AS active_15m,
       (SELECT count(*) FROM whatsapp_sessions
         WHERE last_inbound_at > now() - interval '24 hours')           AS active_24h,
       (SELECT count(*) FROM payments
         WHERE status = 'created' AND created_at > now() - interval '30 minutes') AS paying_now,
       (SELECT count(*) FROM event_log
         WHERE kind = 'vehicle_check' AND created_at > now() - interval '15 minutes') AS checks_15m`);

  return {
    messages: rows.reverse().map(r => ({ ...r, id: String(r.id) })),
    last_message_id: counts.last_message_id ? String(counts.last_message_id) : null,
    active_15m: Number(counts.active_15m),
    active_24h: Number(counts.active_24h),
    paying_now: Number(counts.paying_now),
    checks_15m: Number(counts.checks_15m),
    /*
     * Whether the chat is on at all. Without this the Live screen cannot tell
     * "nobody is messaging" from "messaging is switched off", and it shows an
     * empty panel that reads as broken.
     */
    whatsapp_on: require('../config').config.whatsapp.enabled,
    at: new Date().toISOString(),
  };
}

/** The most recent things that happened, whatever kind they were. */
async function activity({ limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT e.id, e.kind, e.detail, e.created_at, u.mobile, u.wa_profile_name AS name,
            v.reg_no
       FROM event_log e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN vehicles v ON v.id = e.vehicle_id
      WHERE e.kind <> 'funnel'
      ORDER BY e.id DESC LIMIT $1`, [Math.min(200, limit)]);
  return rows.map(r => ({ ...r, id: String(r.id) }));
}


/**
 * WHO IS ON THE SITE (user, 2026-09-21): every signed-in visitor active in the
 * last `minutes`, with where they are — the page, the vehicle, the last thing
 * they did — read from the session row that site/activity.js keeps current.
 * Sessions signed out inside the window are listed too, marked offline, so a
 * visitor who just left does not simply vanish.
 */
async function visitors({ minutes = 30 } = {}) {
  const { rows } = await db.query(
    `SELECT s.id, s.user_id, s.created_at, s.last_used_at, s.ended_at, s.ended_reason,
            s.request_count, coalesce(s.last_ip, s.ip) AS ip, s.user_agent,
            s.current_page, s.current_reg_no, s.current_action, s.current_at, s.current_detail,
            u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.state_code,
            CASE WHEN s.ended_at IS NULL AND s.last_used_at > now() - interval '15 minutes' THEN 'online'
                 WHEN s.ended_at IS NULL THEN 'idle'
                 ELSE coalesce(s.ended_reason, 'ended') END AS state,
            EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') AS has_paid,
            (SELECT count(*) FROM site_activity a WHERE a.session_id = s.id AND a.kind = 'page')::int AS pages,
            (SELECT count(DISTINCT a.reg_no) FROM site_activity a WHERE a.session_id = s.id AND a.reg_no IS NOT NULL)::int AS vehicles,
            (SELECT array_agg(DISTINCT a.reg_no) FROM site_activity a
              WHERE a.session_id = s.id AND a.reg_no IS NOT NULL) AS vehicle_list
       FROM site_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE greatest(s.last_used_at, coalesce(s.ended_at, s.last_used_at), coalesce(s.current_at, s.last_used_at))
            > now() - ($1 || ' minutes')::interval
      ORDER BY greatest(s.last_used_at, coalesce(s.ended_at, s.last_used_at), coalesce(s.current_at, s.last_used_at)) DESC
      LIMIT 100`, [String(Math.min(24 * 60, Math.max(5, Number(minutes) || 30)))]);

  const device = require('../site/device');
  return rows.map((r) => {
    const d = device.parseUA(r.user_agent);
    return { ...r, id: String(r.id), user_id: String(r.user_id), user_agent: undefined,
             device: [d.device_type, d.os, d.browser].filter(Boolean).join(' · ') || null };
  });
}

/** One visit, step by step, newest first. */
async function trail(sessionId, { limit = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT id, kind, page, action, reg_no, detail, ip, created_at
       FROM site_activity WHERE session_id = $1
      ORDER BY id DESC LIMIT $2`, [String(sessionId).replace(/D/g, '') || '0', Math.min(1000, limit)]);
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

/**
 * EVERY CUSTOMER, THEIR OWN TABLE (user, 2026-09-21): one row per signed-in
 * customer active in the last `days` — visits, pages, clicks, actions, the last
 * thing they did and whether they are on the site now. Tap one for the table.
 */
async function customers({ days = 7, q = '' } = {}) {
  const term = String(q || '').trim();
  const digits = term.replace(/\D/g, '');
  const { rows } = await db.query(
    `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
            count(DISTINCT a.session_id)::int AS visits,
            count(*) FILTER (WHERE a.kind = 'page')::int   AS pages,
            count(*) FILTER (WHERE a.kind = 'click')::int  AS clicks,
            count(*) FILTER (WHERE a.kind = 'action')::int AS actions,
            count(DISTINCT a.reg_no)::int AS vehicles,
            max(a.created_at) AS last_at,
            (SELECT CASE WHEN x.kind = 'click' THEN 'Clicked “' || coalesce(x.detail->>'label', '') || '”'
                         WHEN x.kind = 'page' THEN 'Opened ' || coalesce(x.page, '') ELSE x.action END
               FROM site_activity x WHERE x.user_id = u.id ORDER BY x.id DESC LIMIT 1) AS last_what,
            EXISTS (SELECT 1 FROM site_sessions s WHERE s.user_id = u.id AND s.ended_at IS NULL
                      AND s.last_used_at > now() - interval '15 minutes') AS online
       FROM site_activity a JOIN users u ON u.id = a.user_id
      WHERE a.created_at > now() - ($1 || ' days')::interval
        AND ($2 = '' OR u.mobile LIKE '%' || $3 || '%' OR coalesce(u.display_name, '') ILIKE '%' || $2 || '%')
      GROUP BY u.id
      ORDER BY max(a.created_at) DESC LIMIT 300`,
    [String(Math.min(180, Math.max(1, Number(days) || 7))), term, digits || term]);
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

/** One customer's table: every page, click and action, newest first, across all visits. */
async function customerActivity(userId, { kind = null, before = null, limit = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT a.id, a.session_id, a.kind, a.page, a.action, a.reg_no, a.detail, a.ip, a.created_at
       FROM site_activity a
      WHERE a.user_id = $1
        AND ($2::text IS NULL OR a.kind = $2)
        AND ($3::bigint IS NULL OR a.id < $3)
      ORDER BY a.id DESC LIMIT $4`,
    [userId, kind, before, Math.min(1000, Math.max(1, Number(limit) || 200))]);
  const u = await db.one(`SELECT id, mobile, coalesce(display_name, wa_profile_name) AS name, email FROM users WHERE id = $1`, [userId]);
  return { customer: u ? { ...u, id: String(u.id) } : null,
           rows: rows.map((r) => ({ ...r, id: String(r.id), session_id: r.session_id ? String(r.session_id) : null })) };
}

module.exports = { conversations, thread, pulse, activity, visitors, trail, customers, customerActivity };
