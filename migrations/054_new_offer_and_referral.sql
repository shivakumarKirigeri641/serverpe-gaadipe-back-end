-- 054_new_offer_and_referral.sql — the offer GaadiPe actually sells (user, 2026-09-23).
--
-- WHAT CHANGED, AND WHY. The people arriving are not used-vehicle buyers; they
-- are owners checking their own two-wheeler — 19 of the first 27 plates were a
-- scooter, one each, from every corner of the country. An owner does not want a
-- document. He wants to not be stopped by a policeman, and to not find out his
-- insurance lapsed three weeks ago. So the same ₹19 now buys:
--
--   the full report            as before
--   challans watched 3 months  90 days instead of 28 — checked closely at first,
--                              then slower, because worry fades and cost does not
--   expiry warnings, no end    insurance, PUC, road tax, fitness and permit dates
--                              are ALREADY STORED, so warning him costs one RC
--                              call at the moment of warning, not one a day for
--                              a year. PUC is usually six-monthly: a 28-day
--                              window caught roughly one in six of them.
--
-- THE PRICE DOES NOT MOVE. ₹19 has never been refused, because almost nobody has
-- reached the payment page to refuse it. Changing the offer and the price at once
-- would leave us unable to say which one mattered. plans.price_paise is data, so
-- ₹29 is an afternoon's decision once the ULIP rate card says what a call costs.
--
-- QUIZPE REFERRALS STOP, GAADIPE REFERRALS START. Asking a scooter owner to
-- recruit a school parent for a quiz app, to earn a vehicle report, is two
-- funnels multiplied — and it has been tapped zero times. "Refer someone who
-- also has a vehicle" is one step and an obvious match. Nothing is deleted: the
-- QuizPe machinery stays, switched off, and credits already earned stay usable.

/* ─────────────────────────────── 1. the offer ─────────────────────────────── */

-- Challans are watched for three months now, not four weeks.
UPDATE plans SET duration_days = 90 WHERE code = 'REPORT19' AND duration_days = 28;

-- Checked every 48h while it is fresh, then weekly. Worry fades; cost does not.
INSERT INTO app_settings (key, value) VALUES ('watch_taper_after_days', '28')
ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('watch_interval_minutes_challan_late', '10080')
ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('watch_interval_minutes_rc_late', '43200')
ON CONFLICT (key) DO NOTHING;

-- How many days before an expiry we warn. Several, because one message a month
-- before is forgotten and one on the day is too late to act on.
INSERT INTO app_settings (key, value) VALUES ('expiry_warn_days', '30,7,1')
ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('expiry_warnings_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
-- Long after the watch has ended we still warn — but only for someone who paid,
-- and only for this long, so a single ₹19 does not oblige us for ever.
INSERT INTO app_settings (key, value) VALUES ('expiry_warning_months', '18')
ON CONFLICT (key) DO NOTHING;

/*
 * One row per warning actually sent, so the same expiry is never announced
 * twice. Keyed on the DATE as well as the document: when he renews, the new
 * date is a new expiry and deserves its own warning a year later.
 */
CREATE TABLE IF NOT EXISTS expiry_warnings (
  id           bigserial PRIMARY KEY,
  user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id   bigint      NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  document     text        NOT NULL,          -- insurance | pucc | tax | fitness | permit
  valid_until  date        NOT NULL,
  days_before  integer     NOT NULL,          -- which of expiry_warn_days this was
  channel      text,                          -- email | whatsapp
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expiry_warned_once
    ON expiry_warnings (vehicle_id, user_id, document, valid_until, days_before);
CREATE INDEX IF NOT EXISTS idx_expiry_warned_recent ON expiry_warnings (created_at DESC);

/* ──────────────────────── 2. GaadiPe's own referral ──────────────────────── */

/*
 * A referral is only ever created by a real tap on a real link, and only ever
 * rewarded when the referred person's own payment is CONFIRMED — from
 * billing.activate(), the same place the report is delivered, so a credit
 * cannot exist where money did not land.
 *
 * device_id and the payment instrument are recorded because a second SIM in the
 * same phone is not a second person, and ₹19-for-a-free-report is exactly the
 * kind of prize that makes someone try.
 */
CREATE TABLE IF NOT EXISTS gaadipe_referrals (
  id                bigserial PRIMARY KEY,
  referrer_id       bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  link_id           bigint      REFERENCES referral_links(id) ON DELETE SET NULL,
  code              text        NOT NULL,
  -- Filled in as the referred person goes: tapped -> signed in -> paid.
  referred_user_id  bigint      REFERENCES users(id) ON DELETE SET NULL,
  mobile_masked     text,
  mobile_hash       text,
  device_id         text,
  ip                text,
  status            text        NOT NULL DEFAULT 'tapped',
                    -- tapped | signed_up | rewarded | not_eligible | expired
  status_reason     text,
  payment_id        bigint      REFERENCES payments(id) ON DELETE SET NULL,
  tapped_at         timestamptz NOT NULL DEFAULT now(),
  signed_up_at      timestamptz,
  rewarded_at       timestamptz,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gp_ref_referrer ON gaadipe_referrals (referrer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gp_ref_pending  ON gaadipe_referrals (status) WHERE status IN ('tapped', 'signed_up');
-- One person can only ever be somebody's referral once, however many links they tap.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gp_ref_person_once
    ON gaadipe_referrals (referred_user_id) WHERE referred_user_id IS NOT NULL;

-- A GaadiPe credit points at a GaadiPe referral; the old column still points at
-- QuizPe's, so both histories stay readable.
ALTER TABLE report_credits
  ADD COLUMN IF NOT EXISTS gaadipe_referral_id bigint REFERENCES gaadipe_referrals(id) ON DELETE SET NULL;

INSERT INTO app_settings (key, value) VALUES ('gaadipe_referral_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
-- How long a referred tap stays live before it is too late to count.
INSERT INTO app_settings (key, value) VALUES ('gaadipe_referral_window_days', '30')
ON CONFLICT (key) DO NOTHING;
-- The most free reports one person can earn in a month.
INSERT INTO app_settings (key, value) VALUES ('gaadipe_referral_monthly_cap', '10')
ON CONFLICT (key) DO NOTHING;

/* ───────────────────────────── 3. QuizPe stops ───────────────────────────── */

-- Switched off, not removed: the tables, the module and the admin screen stay,
-- and credits already earned stay usable until they expire.
UPDATE app_settings SET value = 'false' WHERE key = 'referral_enabled';
INSERT INTO app_settings (key, value) VALUES ('quizpe_consent_at_signin', 'false')
ON CONFLICT (key) DO UPDATE SET value = 'false';
