-- 106_support_inbox.sql — emails that arrived at the support mailbox
-- (support@gaadipe.in, read over IMAP by src/jobs/supportInbox.js): who, what,
-- a short preview, and whether someone has dealt with it. The full message
-- stays in the mailbox itself.

CREATE TABLE IF NOT EXISTS support_emails (
  id           bigserial   PRIMARY KEY,
  mailbox      text        NOT NULL,
  uid          bigint      NOT NULL,
  message_id   text,
  from_name    text,
  from_email   text,
  subject      text,
  preview      text,
  received_at  timestamptz,
  status       text        NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done')),
  done_by      bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  done_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox, uid)
);
CREATE INDEX IF NOT EXISTS support_emails_status ON support_emails (status, received_at DESC);
