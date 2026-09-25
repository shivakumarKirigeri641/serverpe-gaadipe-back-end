/**
 * src/admin/whatsappStats.js — the WhatsApp page's numbers (user, 2026-09-25,
 * command center phase 4).
 * ---------------------------------------------------------------------------
 * What went through the chat for a period, against the one before:
 *   messages in, replies out, templates, and what WhatsApp's receipts say
 *   happened to them (sent, delivered, read, failed); people, new chats, STOP,
 *   blocked; the chat's own funnel; each template's delivery; the hour of day
 *   people write; and the latest failures, with WhatsApp's reason.
 *
 * Receipts come from whatsapp_status_logs — WhatsApp's word, not ours. A
 * message counts as delivered if any receipt said delivered or read.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const command = require('./command');

async function numbers(from, to) {
  const n = await db.one(
    `WITH m AS (SELECT * FROM whatsapp_messages WHERE created_at >= $1 AND created_at < $2),
          r AS (SELECT wa_message_id, bool_or(status IN ('delivered','read')) AS delivered,
                       bool_or(status = 'read') AS read, bool_or(status = 'failed') AS failed
                  FROM whatsapp_status_logs WHERE created_at >= $1 AND created_at < $2 + interval '1 day'
                 GROUP BY wa_message_id)
     SELECT
       count(*) FILTER (WHERE m.direction = 'in')::int                                            AS incoming,
       count(*) FILTER (WHERE m.direction = 'out' AND m.message_type <> 'template')::int         AS replies,
       count(*) FILTER (WHERE m.direction = 'out' AND m.message_type = 'template')::int          AS templates,
       count(*) FILTER (WHERE m.direction = 'out')::int                                           AS outgoing,
       count(*) FILTER (WHERE m.direction = 'out' AND r.delivered)::int                           AS delivered,
       count(*) FILTER (WHERE m.direction = 'out' AND r.read)::int                                AS read,
       count(*) FILTER (WHERE m.direction = 'out' AND (r.failed OR m.error_message IS NOT NULL))::int AS failed,
       count(DISTINCT m.mobile) FILTER (WHERE m.direction = 'in')::int                            AS people
       FROM m LEFT JOIN r ON r.wa_message_id = m.wa_message_id`, [from, to]);
  const e = await db.one(
    `SELECT count(*) FILTER (WHERE name = 'whatsapp_chat_started')::int      AS new_chats,
            count(*) FILTER (WHERE name = 'whatsapp_vehicle_received')::int  AS vehicles,
            count(*) FILTER (WHERE name = 'report_generated')::int           AS reports,
            count(*) FILTER (WHERE name = 'payment_started')::int            AS pay_started,
            count(*) FILTER (WHERE name = 'payment_success')::int            AS paid,
            count(*) FILTER (WHERE name = 'whatsapp_opt_out')::int           AS stops,
            count(*) FILTER (WHERE name = 'whatsapp_ad_clicked')::int        AS from_ads
       FROM events WHERE occurred_at >= $1 AND occurred_at < $2`, [from, to]);
  return { ...n, ...e };
}

const TILES = [
  ['incoming', 'Messages in', 'Messages customers sent to GaadiPe.'],
  ['people', 'People writing', 'Different people who sent at least one message.'],
  ['new_chats', 'New chats', 'People writing to GaadiPe for the very first time.'],
  ['replies', 'Replies sent', 'Free-form replies inside the 24-hour window — no template charge.'],
  ['templates', 'Templates sent', 'Business-started messages (alerts, broadcasts, reminders) — charged by WhatsApp.'],
  ['delivered', 'Delivered', "Messages WhatsApp confirmed as delivered (or read)."],
  ['read', 'Read', 'Messages WhatsApp confirmed as read — only when the person has read receipts on.'],
  ['failed', 'Failed', "Messages WhatsApp refused or could not deliver — see Failures below.", true],
  ['vehicles', 'Vehicle numbers', 'Vehicle numbers typed into the chat.'],
  ['paid', 'Payments', 'Payments completed.'],
  ['stops', 'Replied STOP', 'People who asked GaadiPe to stop messaging them.', true],
  ['from_ads', 'From WhatsApp ads', 'Chats that began from a click-to-WhatsApp ad.'],
];

async function stats(q = {}) {
  const r = command.resolve(q);
  const [cur, prev, extra] = await Promise.all([
    numbers(r.from, r.to),
    r.prevFrom ? numbers(r.prevFrom, r.prevTo) : null,
    db.one(`SELECT count(*)::int AS blocked FROM blocks WHERE kind = 'mobile' AND released_at IS NULL`),
  ]);
  const tiles = TILES.map(([key, label, note, worseUp]) => ({
    key, label, note, worse_up: !!worseUp, value: cur[key], previous: prev ? prev[key] : null,
    change_pct: prev && prev[key] ? Math.round(((cur[key] - prev[key]) / prev[key]) * 1000) / 10 : null,
  }));
  const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

  const [templates, hours, daily, failures, funnel] = await Promise.all([
    db.query(
      `WITH t AS (SELECT * FROM whatsapp_messages
                   WHERE direction = 'out' AND message_type = 'template' AND created_at >= $1 AND created_at < $2),
            r AS (SELECT wa_message_id, bool_or(status IN ('delivered','read')) d, bool_or(status = 'read') rd,
                         bool_or(status = 'failed') f FROM whatsapp_status_logs GROUP BY wa_message_id)
       SELECT coalesce(t.template_name, '(unknown)') AS template, count(*)::int AS sent,
              count(*) FILTER (WHERE r.d)::int AS delivered, count(*) FILTER (WHERE r.rd)::int AS read,
              count(*) FILTER (WHERE r.f OR t.error_message IS NOT NULL)::int AS failed
         FROM t LEFT JOIN r ON r.wa_message_id = t.wa_message_id
        GROUP BY 1 ORDER BY sent DESC`, [r.from, r.to]),
    db.query(
      `SELECT extract(hour FROM created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, count(*)::int AS n
         FROM whatsapp_messages WHERE direction = 'in' AND created_at >= $1 AND created_at < $2
        GROUP BY 1 ORDER BY 1`, [r.from, r.to]),
    db.query(
      `SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
              count(*) FILTER (WHERE direction = 'in')::int AS incoming,
              count(*) FILTER (WHERE direction = 'out' AND message_type <> 'template')::int AS replies,
              count(*) FILTER (WHERE direction = 'out' AND message_type = 'template')::int AS templates
         FROM whatsapp_messages WHERE created_at >= $1 AND created_at < $2
        GROUP BY 1 ORDER BY 1`, [r.from, r.to]),
    db.query(
      `SELECT m.created_at, m.mobile, m.message_type, m.template_name, left(m.body, 120) AS body,
              coalesce(m.error_message, s.error_title, s.error_code) AS reason
         FROM whatsapp_messages m
         LEFT JOIN LATERAL (SELECT error_title, error_code FROM whatsapp_status_logs s
                             WHERE s.wa_message_id = m.wa_message_id AND s.status = 'failed'
                             ORDER BY s.id DESC LIMIT 1) s ON true
        WHERE m.direction = 'out' AND m.created_at >= $1 AND m.created_at < $2
          AND (m.error_message IS NOT NULL OR s.error_title IS NOT NULL OR s.error_code IS NOT NULL)
        ORDER BY m.created_at DESC LIMIT 30`, [r.from, r.to]),
    command.overview({ ...q }).then((o) => o.funnel.filter((s) => !['web_visit', 'web_vehicle', 'wa_click'].includes(s.key))),
  ]);

  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, n: hours.rows.find((x) => x.hour === h)?.n || 0 }));
  return {
    range: { label: r.label, from: r.from, to: r.to },
    compare: r.prevFrom ? { label: r.compareLabel } : null,
    tiles,
    rates: {
      delivery_pct: rate(cur.delivered, cur.outgoing),
      read_pct: rate(cur.read, cur.delivered),
      failure_pct: rate(cur.failed, cur.outgoing),
      user_initiated: cur.replies, business_initiated: cur.templates,
    },
    blocked_total: extra.blocked,
    funnel,
    templates: templates.rows.map((t) => ({ ...t, delivery_pct: rate(t.delivered, t.sent), read_pct: rate(t.read, t.delivered) })),
    by_hour: byHour,
    daily: daily.rows,
    failures: failures.rows,
  };
}

module.exports = { stats };
