-- 067_events_and_visitors.sql — one event stream, website to WhatsApp to
-- payment, for the admin command center (user, 2026-09-25).
--
-- WHY A NEW TABLE. What happens to a customer is recorded today in six places
-- — event_log funnel steps, whatsapp_messages, api_calls, payments,
-- vehicle_reports, site_activity — each shaped for its own job. The command
-- center needs them as ONE time-ordered stream it can count, compare and open
-- per person. Those tables stay the source of truth; `events` is the index
-- written alongside them (src/events/track.js) and backfilled here.
--
-- IDEMPOTENT BY CONSTRUCTION. Every event carries event_key, unique: the id of
-- the row it came from ("wa_msg:<wamid>", "funnel:<event_log id>",
-- "pay_ok:<payment id>") or, from a browser, the client's own event id. A
-- retried webhook, a refreshed page or a re-run backfill writes nothing twice.
--
-- PRIVACY. No raw IP is kept — only a salted hash, to count distinct visitors,
-- and the city-level place the offline lookup gives. Mobiles are stored as the
-- rest of the system stores them (the admin already sees them); the panel
-- masks them for roles that do not need them.

/* ─────────────────────────────── visitors ─────────────────────────────── */

-- One anonymous website visitor (a browser), with where they first and last
-- came from, and — once they write on WhatsApp with their code — who they are.
CREATE TABLE IF NOT EXISTS visitors (
  visitor_id       text        PRIMARY KEY,           -- random, made in the browser
  wa_code          text,                              -- "K7Q2M": typed into WhatsApp to link
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  first_touch      jsonb       NOT NULL DEFAULT '{}',  -- source, medium, campaign, term, content, referrer, landing
  last_touch       jsonb       NOT NULL DEFAULT '{}',
  device           jsonb       NOT NULL DEFAULT '{}',  -- device_type, os, browser (never the raw user agent)
  place            jsonb       NOT NULL DEFAULT '{}',  -- country, region, city — never finer
  user_id          bigint      REFERENCES users(id) ON DELETE SET NULL,
  mobile           text,
  linked_at        timestamptz,
  page_views       integer     NOT NULL DEFAULT 0,
  wa_clicks        integer     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS visitors_mobile_idx    ON visitors (mobile);
-- Not UNIQUE: ON CONFLICT (visitor_id) cannot also arbitrate a second unique
-- column, and a shared code (1 in ~28 million) simply links the latest visitor.
CREATE INDEX IF NOT EXISTS visitors_wa_code_idx   ON visitors (wa_code);
CREATE INDEX IF NOT EXISTS visitors_first_seen_idx ON visitors (first_seen_at);

/* ──────────────────────────────── events ──────────────────────────────── */

CREATE TABLE IF NOT EXISTS events (
  id           bigserial   PRIMARY KEY,
  event_key    text        NOT NULL UNIQUE,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  name         text        NOT NULL,            -- page_view, whatsapp_cta_clicked, payment_success …
  channel      text        NOT NULL,            -- web | whatsapp | system
  visitor_id   text,
  session_id   text,
  user_id      bigint,
  mobile       text,
  reg_no       text,
  payment_id   bigint,
  source       text,                            -- google, direct, whatsapp_ad, … (attribution)
  campaign     text,
  page         text,
  status       text,                            -- ok | failed | … where it applies
  error_code   text,
  duration_ms  integer,
  amount_paise integer,
  metadata     jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_time_idx      ON events (occurred_at);
CREATE INDEX IF NOT EXISTS events_name_time_idx ON events (name, occurred_at);
CREATE INDEX IF NOT EXISTS events_mobile_idx    ON events (mobile, occurred_at);
CREATE INDEX IF NOT EXISTS events_visitor_idx   ON events (visitor_id, occurred_at);
CREATE INDEX IF NOT EXISTS events_user_idx      ON events (user_id, occurred_at);

/* WhatsApp chats remember the website visitor or the ad they came from. */
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS visitor_id  text;
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS attribution jsonb NOT NULL DEFAULT '{}';

/* ─────────────────────────────── backfill ────────────────────────────────
   The history already recorded, so the command center starts with it. Each
   insert is keyed like the live writer, so running it again adds nothing.   */

-- Bot steps, under the names the command center uses.
INSERT INTO events (event_key, occurred_at, name, channel, user_id, mobile, reg_no, payment_id, status, metadata)
SELECT 'funnel:' || e.id, e.created_at,
       CASE e.detail->>'step'
         WHEN 'hi'            THEN 'whatsapp_greeting'
         WHEN 'agreed'        THEN 'terms_accepted'
         WHEN 'number'        THEN 'whatsapp_vehicle_received'
         WHEN 'basic_shown'   THEN 'vehicle_search_success'
         WHEN 'lookup_failed' THEN 'vehicle_search_failed'
         WHEN 'buy_tapped'    THEN 'report_preview_viewed'
         WHEN 'link_sent'     THEN 'payment_started'
         WHEN 'opt_out'       THEN 'whatsapp_opt_out'
         WHEN 'opt_in'        THEN 'whatsapp_opt_in'
         ELSE 'whatsapp_' || (e.detail->>'step') END,
       'whatsapp', e.user_id, e.detail->>'mobile', e.detail->>'reg_no',
       nullif(e.detail->>'payment_row', '')::bigint,
       CASE WHEN e.detail->>'step' = 'lookup_failed' THEN 'failed' ELSE 'ok' END,
       e.detail
  FROM event_log e
 WHERE e.kind = 'funnel'
ON CONFLICT (event_key) DO NOTHING;

-- Every WhatsApp message in; the first one per number also as chat_started.
INSERT INTO events (event_key, occurred_at, name, channel, user_id, mobile, metadata)
SELECT 'wa_msg:' || coalesce(m.wa_message_id, m.id::text), m.created_at, 'whatsapp_message_received',
       'whatsapp', s.user_id, m.mobile, jsonb_build_object('type', m.message_type)
  FROM whatsapp_messages m LEFT JOIN whatsapp_sessions s ON s.mobile = m.mobile
 WHERE m.direction = 'in'
ON CONFLICT (event_key) DO NOTHING;

INSERT INTO events (event_key, occurred_at, name, channel, user_id, mobile)
SELECT 'wa_chat:' || s.mobile, s.created_at, 'whatsapp_chat_started', 'whatsapp', s.user_id, s.mobile
  FROM whatsapp_sessions s
ON CONFLICT (event_key) DO NOTHING;

-- Government-records calls.
INSERT INTO events (event_key, occurred_at, name, channel, user_id, reg_no, status, error_code, duration_ms, metadata)
SELECT 'api:' || a.id, a.created_at, CASE WHEN a.ok THEN 'vehicle_api_success' ELSE 'vehicle_api_failed' END,
       'system', a.user_id, a.reg_no, CASE WHEN a.ok THEN 'ok' ELSE 'failed' END, a.error_code, a.duration_ms,
       jsonb_build_object('dataset', a.dataset, 'cache_hit', a.cache_hit, 'http_status', a.http_status, 'cost_paise', a.cost_paise)
  FROM api_calls a
ON CONFLICT (event_key) DO NOTHING;

-- Payments that completed, and the reports issued.
INSERT INTO events (event_key, occurred_at, name, channel, user_id, mobile, payment_id, amount_paise, status)
SELECT 'pay_ok:' || p.id, coalesce(p.paid_at, p.created_at), 'payment_success', 'system', p.user_id, u.mobile,
       p.id, p.amount_paise, 'ok'
  FROM payments p LEFT JOIN users u ON u.id = p.user_id
 WHERE p.status = 'paid'
ON CONFLICT (event_key) DO NOTHING;

INSERT INTO events (event_key, occurred_at, name, channel, user_id, reg_no, payment_id, metadata)
SELECT 'report:' || r.id, r.created_at, 'report_generated', 'system', r.user_id, r.reg_no, r.payment_id,
       jsonb_build_object('report_number', r.report_number)
  FROM vehicle_reports r
ON CONFLICT (event_key) DO NOTHING;
