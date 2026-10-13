/**
 * src/admin/waReplies.js — WHATSAPP REPLIES & TAPS (user, 2026-10-13: "track replies from
 * customers — when they tap reply on WhatsApp, where?").
 *
 * Every message a customer sent on WhatsApp, with what it answered: a tap on a template's
 * quick-reply button (Thanks for remembering, Pause this alert, …), a tap on the bot's own
 * buttons and lists, or typed text. WhatsApp puts the id of the message being answered on
 * a button tap or a swiped reply (payload.context.id); without it, the last template sent
 * to that number in the 72 hours before is taken as what was answered.
 *
 *   list()     the replies, newest first, with filters
 *   summary()  per template: how many replies, and how many taps on each button
 * The admin API's consent filter (consented.js) leaves out anyone who never agreed.
 */

const db = require('../db');

const SAID = `coalesce(m.payload->'button'->>'text', m.payload->'interactive'->'button_reply'->>'title',
                       m.payload->'interactive'->'list_reply'->>'title', m.payload->'text'->>'body', m.body)`;
const KINDS = {
  all: 'true',
  buttons: `m.message_type IN ('button', 'interactive')`,
  templates: `o.template_name IS NOT NULL`,
  typed: `m.message_type = 'text'`,
};

const BASE = (where) => `
  SELECT m.id, right(m.mobile, 10) AS mobile, m.created_at AS at, m.message_type AS type, ${SAID} AS said,
         coalesce(m.payload->'button'->>'payload', m.payload->'interactive'->'button_reply'->>'id', m.payload->'interactive'->'list_reply'->>'id') AS tap_id,
         coalesce(u.display_name, u.wa_profile_name) AS name, u.is_internal,
         o.template_name, o.message_type AS answered_type, left(o.body, 300) AS answered, o.created_at AS answered_at
    FROM whatsapp_messages m
    LEFT JOIN users u ON right(u.mobile, 10) = right(m.mobile, 10)
    LEFT JOIN LATERAL (
      SELECT x.template_name, x.message_type, x.body, x.created_at FROM whatsapp_messages x
       WHERE x.direction = 'out'
         AND (CASE WHEN m.payload->'context'->>'id' IS NOT NULL
                   THEN x.wa_message_id = m.payload->'context'->>'id'
                   ELSE right(x.mobile, 10) = right(m.mobile, 10) AND x.message_type = 'template'
                        AND x.created_at < m.created_at AND x.created_at > m.created_at - interval '72 hours' END)
       ORDER BY x.created_at DESC LIMIT 1) o ON true
   WHERE m.direction = 'in' AND m.created_at > now() - ($1 || ' days')::interval
     AND ${where}`;

async function list({ days = 7, kind = 'all', template = '', q = '', limit = 500 } = {}) {
  const n = String(Math.min(90, Math.max(1, Number(days) || 7)));
  const term = String(q || '').trim();
  const { rows } = await db.query(
    `${BASE(`(${KINDS[kind] || 'true'})
       AND ($2 = '' OR o.template_name = $2)
       AND ($3 = '' OR m.mobile LIKE '%' || $3 || '%' OR coalesce(u.display_name, u.wa_profile_name, '') ILIKE '%' || $3 || '%'
            OR ${SAID} ILIKE '%' || $3 || '%')`)}
     ORDER BY m.created_at DESC LIMIT $4`, [n, String(template || ''), term, Math.min(2000, Number(limit) || 500)]);
  return { days: Number(n), rows: rows.map((r) => ({ ...r, id: String(r.id) })) };
}

async function summary({ days = 7 } = {}) {
  const n = String(Math.min(90, Math.max(1, Number(days) || 7)));
  const { rows } = await db.query(
    `WITH r AS (${BASE('true')})
     SELECT template_name, count(*)::int AS replies,
            count(DISTINCT mobile)::int AS people,
            count(*) FILTER (WHERE type IN ('button', 'interactive'))::int AS taps,
            coalesce(jsonb_object_agg(said, c) FILTER (WHERE said IS NOT NULL AND type IN ('button', 'interactive')), '{}'::jsonb) AS buttons
       FROM (SELECT template_name, mobile, type, said, count(*) OVER (PARTITION BY template_name, said) AS c FROM r) z
      WHERE template_name IS NOT NULL
      GROUP BY template_name ORDER BY replies DESC`, [n]);
  // Templates sent in the same days, for "replied by x of y".
  const { rows: sent } = await db.query(
    `SELECT template_name, count(DISTINCT right(mobile, 10))::int AS people FROM whatsapp_messages
      WHERE direction = 'out' AND message_type = 'template' AND coalesce(error_message, '') = ''
        AND created_at > now() - ($1 || ' days')::interval GROUP BY 1`, [n]);
  const sentTo = Object.fromEntries(sent.map((s) => [s.template_name, s.people]));
  return { days: Number(n), templates: rows.map((r) => ({ ...r, sent_to: sentTo[r.template_name] || 0 })) };
}

module.exports = { list, summary };
