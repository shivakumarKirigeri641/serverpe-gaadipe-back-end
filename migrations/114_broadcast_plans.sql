-- 114_broadcast_plans.sql — BROADCAST IN BATCHES (user, 2026-10-05,
-- src/admin/broadcastPlans.js). One message to a whole audience, sent batch by
-- batch so no 24 hours goes over the WhatsApp messaging limit (250, shared
-- with QuizPe). Each batch is an ordinary broadcast (whatsapp_broadcasts), so
-- sending, STOP, blocks and delivery reports work exactly as they do now.
--
--   mobiles      everyone the plan is for, fixed when it is made
--   batch_size   most people in one batch
--   gap_hours    hours between batches (24 = the window has moved on)
--   reserve      places in the 24 hours kept free for alerts and QuizPe
--   status       running | paused | done | cancelled
--   next_at      when the next batch may go

CREATE TABLE IF NOT EXISTS broadcast_plans (
  id            bigserial   PRIMARY KEY,
  admin_id      bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  template_name text        NOT NULL,
  language      text        NOT NULL DEFAULT 'en',
  variables     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  note          text,
  mobiles       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  batch_size    integer     NOT NULL DEFAULT 150 CHECK (batch_size BETWEEN 1 AND 2000),
  gap_hours     numeric     NOT NULL DEFAULT 24 CHECK (gap_hours >= 1),
  reserve       integer     NOT NULL DEFAULT 50 CHECK (reserve >= 0),
  status        text        NOT NULL DEFAULT 'running',
  next_at       timestamptz NOT NULL DEFAULT now(),
  broadcast_ids jsonb       NOT NULL DEFAULT '[]'::jsonb,
  last_note     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  modified_at   timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS broadcast_plans_due ON broadcast_plans (next_at) WHERE status = 'running';
