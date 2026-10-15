-- 187_sms_templates.sql (user, 2026-10-15: "in SMS broadcast, put one selectable SMS template and
-- typing 1 or 2 or 3 parameters based on which template I select, rather than keep on typing the
-- template id, sender id").
--
-- Every DLT-approved template the SMS broadcast may send, kept once: its name, kind (promo = offers,
-- opted-in customers only, 10 am - 9 pm; service = a factual update to everyone who agreed), the
-- Fast2SMS message id, the approved wording with {#var#} for each value, and its header (sender id;
-- empty = the usual FAST2SMS_SENDER_ID for service, Settings sms_promo_sender_id for promo).
-- Each queued SMS remembers its template, so editing or adding one never changes a batch already queued.
CREATE TABLE IF NOT EXISTS sms_templates (
  id          bigserial   PRIMARY KEY,
  name        text        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('promo', 'service')),
  dlt_id      text        NOT NULL,
  body        text        NOT NULL,
  sender      text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  modified_at timestamptz NOT NULL DEFAULT now(),
  created_by  bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS sms_templates_dlt ON sms_templates (dlt_id) WHERE is_active;

ALTER TABLE notify_queue ADD COLUMN IF NOT EXISTS template_id bigint REFERENCES sms_templates(id) ON DELETE SET NULL;

-- The two templates already in Settings become the first entries (nothing is lost).
INSERT INTO sms_templates (name, kind, dlt_id, body, sender)
SELECT 'Promotional (from Settings)', 'promo', trim(both '"' from i.value::text), trim(both '"' from t.value::text),
       nullif(trim(both '"' from (SELECT value::text FROM app_settings WHERE key = 'sms_promo_sender_id')), '')
  FROM app_settings i JOIN app_settings t ON t.key = 'sms_tpl_promo_text'
 WHERE i.key = 'sms_tpl_promo' AND trim(both '"' from i.value::text) <> '' AND trim(both '"' from t.value::text) <> ''
   AND NOT EXISTS (SELECT 1 FROM sms_templates s WHERE s.dlt_id = trim(both '"' from i.value::text));

INSERT INTO sms_templates (name, kind, dlt_id, body)
SELECT 'Service notice (from Settings)', 'service', trim(both '"' from i.value::text), trim(both '"' from t.value::text)
  FROM app_settings i JOIN app_settings t ON t.key = 'sms_tpl_service_text'
 WHERE i.key = 'sms_tpl_service' AND trim(both '"' from i.value::text) <> '' AND trim(both '"' from t.value::text) <> ''
   AND NOT EXISTS (SELECT 1 FROM sms_templates s WHERE s.dlt_id = trim(both '"' from i.value::text));
