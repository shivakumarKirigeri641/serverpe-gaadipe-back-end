-- 103_ad_return.sql — what each Meta ad cost, as entered from Ads Manager
-- (src/admin/opsExtras.js adReturn): the ad's id (or its headline when Meta
-- sent no id) and the total spent on it.

CREATE TABLE IF NOT EXISTS ad_campaign_spend (
  ad_key       text        PRIMARY KEY,
  label        text,
  amount_paise bigint      NOT NULL DEFAULT 0 CHECK (amount_paise >= 0),
  note         text,
  modified_by  bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  modified_at  timestamptz NOT NULL DEFAULT now()
);
