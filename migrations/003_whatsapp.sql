-- 003_whatsapp.sql — the conversation
--
-- WhatsApp is not a notification channel here, it is the whole interface.
-- A session is one person's ongoing conversation and its position in the bot's
-- state machine; `context` carries whatever that state needs (the vehicle being
-- added, the plan being bought) without a column per flow.
--
-- Every message in and out is logged. When a customer says "I never got it",
-- the answer has to be in the database, not in a log file that rotated away.

CREATE TABLE whatsapp_sessions (
  id              bigserial PRIMARY KEY,
  user_id         bigint      REFERENCES users(id) ON DELETE CASCADE,
  -- A session can exist before a user does: someone says "hi" before we know
  -- anything about them.
  mobile          text        NOT NULL CHECK (mobile ~ '^[0-9]{10}$'),
  wa_id           text,
  profile_name    text,
  -- Where the person is in the bot: 'new', 'main_menu', 'awaiting_reg_no',
  -- 'awaiting_payment', 'watching', …
  state           text        NOT NULL DEFAULT 'new',
  state_reason    text,
  context         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Meta only allows free-form replies within 24 hours of the customer's last
  -- message; outside it a paid template is required. Tracking the last inbound
  -- is what decides which one the code may send.
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  modified_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_sessions_mobile_unique UNIQUE (mobile)
);

CREATE INDEX idx_wa_sessions_user ON whatsapp_sessions (user_id);
CREATE INDEX idx_wa_sessions_window ON whatsapp_sessions (last_inbound_at DESC) WHERE is_active;

CREATE TABLE whatsapp_messages (
  id              bigserial PRIMARY KEY,
  session_id      bigint      REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  mobile          text        NOT NULL,
  direction       text        NOT NULL CHECK (direction IN ('in', 'out')),
  -- text | interactive | template | image | document | audio | location | …
  message_type    text,
  body            text,
  -- Full payload sent or received, for reconstructing exactly what happened.
  payload         jsonb,
  template_name   text,
  wa_message_id   text,
  -- Set when a send failed, so a silent failure is visible rather than absent.
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wa_messages_session ON whatsapp_messages (session_id, created_at DESC);
CREATE INDEX idx_wa_messages_wamid ON whatsapp_messages (wa_message_id) WHERE wa_message_id IS NOT NULL;

-- Delivery receipts arrive separately and asynchronously: sent -> delivered ->
-- read, or failed. Kept apart from the message so a receipt arriving twice, or
-- out of order, cannot corrupt the message row.
CREATE TABLE whatsapp_status_logs (
  id              bigserial PRIMARY KEY,
  wa_message_id   text        NOT NULL,
  mobile          text,
  status          text        NOT NULL,      -- sent | delivered | read | failed
  error_code      text,
  error_title     text,
  raw             jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wa_status_wamid ON whatsapp_status_logs (wa_message_id, created_at DESC);

-- Meta holds the real templates; this table is a local send-gate and a record
-- of the parameter count. A template that is missing or unapproved at Meta
-- fails the whole batch, so the code checks here before trying.
CREATE TABLE wa_templates (
  id              bigserial PRIMARY KEY,
  template_name   text        NOT NULL UNIQUE,
  language        text        NOT NULL DEFAULT 'en',
  category        text,                       -- UTILITY | MARKETING | AUTHENTICATION
  -- Ordered names for {{1}}, {{2}}, … Used to validate a fill before sending:
  -- a wrong count is rejected by Meta for the entire batch.
  variables       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  header_text     text,
  body_text       text,
  footer_text     text,
  approval_status text        NOT NULL DEFAULT 'PENDING',
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  modified_at     timestamptz NOT NULL DEFAULT now()
);

-- Web login for the site, kept separate from WhatsApp identity.
CREATE TABLE otp_challenges (
  id           bigserial PRIMARY KEY,
  mobile       text        NOT NULL,
  code_hash    text        NOT NULL,          -- never store the code itself
  attempts     integer     NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_otp_mobile ON otp_challenges (mobile, created_at DESC);
