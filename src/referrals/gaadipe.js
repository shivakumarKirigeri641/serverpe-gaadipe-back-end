/**
 * src/referrals/gaadipe.js — refer someone who also has a vehicle
 * (user, 2026-09-23).
 *
 * WHY THIS REPLACED THE QUIZPE ONE. Asking a scooter owner to recruit a school
 * parent into a quiz app, in order to earn a vehicle report, is two funnels
 * multiplied by each other — and it was tapped zero times. "Refer someone who
 * also has a vehicle" is one step, and everybody your customer knows has one.
 *
 * THE RULE: refer a friend; when they pay for their first report, your next
 * report is free. Nothing is earned for a tap, a sign-in, or an abandoned
 * checkout — only for money that actually landed.
 *
 * WHERE THE REWARD IS GRANTED matters more than it looks. It happens inside
 * billing.activate(), the same place the report itself is delivered, so a
 * credit cannot exist where a payment did not. And billing.refund() takes it
 * back: without that, ₹19 refunded still buys a friend a free report.
 *
 * DISTINCT MEANS DISTINCT. A free report is exactly the size of prize that
 * makes someone try a second SIM in the same phone, so a referral is refused
 * when the referrer and the referred share a device — not only when they share
 * a mobile number. Both are already recorded at sign-in.
 */

const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');
const { config } = require('../config');

const on = async () => String(await settings.get('gaadipe_referral_enabled', 'true')).toLowerCase() !== 'false';
const SITE = () => (process.env.PUBLIC_SITE_URL || 'https://gaadipe.in').replace(/\/+$/, '');
const hash = (v) => crypto.createHash('sha256').update(`gp|${v}`).digest('hex').slice(0, 32);
const mask = (m) => `${String(m).slice(0, 2)}****${String(m).slice(-2)}`;

/* ───────────────────────────────────────────────────────────── the link ── */

/** Their own link, made the first time they ask for it. */
async function ensureLink(userId) {
  const existing = await db.one(`SELECT * FROM referral_links WHERE user_id = $1`, [userId]);
  if (existing) return existing;
  // Short, unambiguous, and no letters that read as digits.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = Array.from(crypto.randomBytes(6)).map((b) => alphabet[b % alphabet.length]).join('');
    const row = await db.one(
      `INSERT INTO referral_links (user_id, code) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING *`, [userId, code]);
    if (row) return row;
  }
  throw new Error('could not allocate a referral code');
}

const linkUrl = (code) => `${SITE()}/r/${code}`;

/*
 * WHERE A REFERRAL LINK LEADS (user, 2026-09-23).
 *
 * Into the GaadiPe chat, with the code already in the message — the friend
 * presses Send and is in the product, with no sign-in, no form and no app.
 * That is a far shorter walk than a website that asks for their number first.
 *
 * While GaadiPe has no number of its own, the link goes to the website
 * instead. Not a compromise about where referrals belong: a link that opens a
 * chat nobody reads is a referral programme nobody can use.
 */
const waNumber = () => String(config.whatsapp.ownNumber || '').replace(/\D/g, '');
const waUrl = (code) => {
  if (!config.whatsapp.enabled || !waNumber()) return null;
  return `https://wa.me/${waNumber()}?text=${encodeURIComponent(`Hi GaadiPe (ref ${code})`)}`;
};

/**
 * The code hidden in "Hi GaadiPe (ref ABC123)".
 *
 * Read from ANY inbound message, whatever the conversation was doing, because
 * it arrives in the very first one — before there is a session, a user or a
 * state to attach it to.
 */
const codeFromText = (text) => {
  const m = String(text || '').match(/\(\s*ref[:\s]+([A-Za-z0-9]{4,12})\s*\)/i);
  return m ? m[1].toUpperCase() : null;
};

/**
 * Someone opened a referral link.
 *
 * Nothing is created here — a tap is not a referral, and a row per tap would
 * let anyone fill the table from a browser. The code is simply confirmed as
 * real, and the site remembers it until they sign in.
 */
async function resolve(code, { viewer = null } = {}) {
  if (!await on()) return { ok: false, reason: 'off' };
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const link = clean ? await db.one(`SELECT * FROM referral_links WHERE code = $1`, [clean]) : null;
  if (!link) return { ok: false, reason: 'unknown' };
  if (!link.is_active) return { ok: false, reason: link.disabled_reason || 'inactive' };

  const owner = await db.one(`SELECT id, display_name, deactivated_at FROM users WHERE id = $1`, [link.user_id]);
  if (!owner || owner.deactivated_at) return { ok: false, reason: 'inactive' };
  // Their own link, in their own browser: say so rather than pretending.
  if (viewer && String(viewer.id) === String(link.user_id)) return { ok: false, reason: 'own_link' };

  return {
    ok: true, code: link.code,
    from: String(owner.display_name || '').split(' ')[0] || null,
    // Present once GaadiPe has a number: the site sends them straight here.
    wa_url: waUrl(link.code),
  };
}

/* ──────────────────────────────────────────────────────── becoming one ── */

/**
 * A signed-in customer says they arrived through a link.
 *
 * Refused for anyone who has been somebody's referral before, for the owner of
 * the link, for a device the referrer has themselves used, and for anyone who
 * has already paid — a referral is for bringing someone new, not for
 * retrospectively claiming a customer GaadiPe already had.
 */
async function attach(user, code, { deviceId = null, ip = null } = {}) {
  if (!await on()) return { ok: false, reason: 'off' };
  const found = await resolve(code, { viewer: user });
  if (!found.ok) return { ok: false, reason: found.reason };

  const link = await db.one(`SELECT * FROM referral_links WHERE code = $1`, [found.code]);
  if (String(link.user_id) === String(user.id)) return { ok: false, reason: 'own_link' };

  const already = await db.one(
    `SELECT id, status FROM gaadipe_referrals WHERE referred_user_id = $1`, [user.id]);
  if (already) return { ok: false, reason: 'already_referred' };

  const paid = await db.one(
    `SELECT 1 FROM payments WHERE user_id = $1 AND status = 'paid' AND amount_paise > 0 LIMIT 1`, [user.id]);
  if (paid) return { ok: false, reason: 'already_a_customer' };

  // The same phone with a second SIM is not a second person.
  if (deviceId) {
    const shared = await db.one(
      `SELECT 1 FROM site_sign_ins WHERE user_id = $1 AND device_id = $2 LIMIT 1`, [link.user_id, deviceId]);
    if (shared) return { ok: false, reason: 'same_device' };
  }

  const windowDays = await settings.num('gaadipe_referral_window_days', 30);
  const row = await db.one(
    `INSERT INTO gaadipe_referrals
       (referrer_id, link_id, code, referred_user_id, mobile_masked, mobile_hash,
        device_id, ip, status, signed_up_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'signed_up', now(), now() + ($9 || ' days')::interval)
     ON CONFLICT (referred_user_id) WHERE referred_user_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [link.user_id, link.id, link.code, user.id, mask(user.mobile), hash(user.mobile),
     deviceId, ip, String(windowDays)]);
  if (!row) return { ok: false, reason: 'already_referred' };

  console.log('[referral] %s joined through %s', mask(user.mobile), link.code);
  return { ok: true, id: String(row.id), from: found.from };
}

/* ─────────────────────────────────────────────────────────── the reward ── */

/**
 * Their first payment landed. Reward whoever sent them.
 *
 * Called from billing.activate(), inside the same flow that delivers the
 * report. Never throws: a referral that cannot be granted must not roll back a
 * payment, and an unrewarded referrer is a support conversation, not a refund.
 */
async function onPaid({ userId, paymentId, amountPaise }) {
  try {
    if (!await on()) return { rewarded: false, reason: 'off' };
    if (!Number(amountPaise) > 0) return { rewarded: false, reason: 'free' };

    const ref = await db.one(
      `SELECT * FROM gaadipe_referrals
        WHERE referred_user_id = $1 AND status = 'signed_up'`, [userId]);
    if (!ref) return { rewarded: false, reason: 'not_referred' };

    if (new Date(ref.expires_at) < new Date()) {
      await db.query(
        `UPDATE gaadipe_referrals SET status = 'expired', status_reason = 'not bought in time' WHERE id = $1`,
        [ref.id]);
      return { rewarded: false, reason: 'expired' };
    }

    const cap = await settings.num('gaadipe_referral_monthly_cap', 10);
    const month = await db.one(
      `SELECT count(*)::int AS n FROM gaadipe_referrals
        WHERE referrer_id = $1 AND rewarded_at > date_trunc('month', now())`, [ref.referrer_id]);
    if (month.n >= cap) {
      await db.query(
        `UPDATE gaadipe_referrals SET status = 'not_eligible', status_reason = 'monthly limit reached',
                payment_id = $2 WHERE id = $1`, [ref.id, paymentId]);
      return { rewarded: false, reason: 'cap' };
    }

    const validDays = await settings.num('referral_credit_valid_days', 90);
    const credit = await db.one(
      `INSERT INTO report_credits (user_id, source, gaadipe_referral_id, reward, payment_id, expires_at)
       VALUES ($1, 'gaadipe_referral', $2, 'free_report', $3, now() + ($4 || ' days')::interval)
       RETURNING id, expires_at`,
      [ref.referrer_id, ref.id, paymentId, String(validDays)]);

    await db.query(
      `UPDATE gaadipe_referrals SET status = 'rewarded', rewarded_at = now(), payment_id = $2 WHERE id = $1`,
      [ref.id, paymentId]);

    console.log('[referral] %s earned a free report (credit %s)', ref.referrer_id, credit.id);
    return { rewarded: true, creditId: String(credit.id), referrerId: String(ref.referrer_id),
             expiresAt: credit.expires_at };
  } catch (e) {
    console.error('[referral] could not grant for payment %s: %s', paymentId, e.message);
    return { rewarded: false, reason: 'error' };
  }
}

/**
 * The payment that earned a reward was refunded.
 *
 * An UNUSED credit is withdrawn; one already spent is left alone, because the
 * report has been delivered and taking it back afterwards would be worse than
 * the loss. Never throws — a refund must always complete.
 */
async function onRefunded(paymentId) {
  try {
    const { rowCount } = await db.query(
      `UPDATE report_credits
          SET revoked_at = now(), revoked_reason = 'the referred payment was refunded'
        WHERE payment_id = $1 AND source = 'gaadipe_referral'
          AND used_at IS NULL AND revoked_at IS NULL`, [paymentId]);
    if (rowCount) {
      await db.query(
        `UPDATE gaadipe_referrals SET status = 'not_eligible', status_reason = 'payment refunded'
          WHERE payment_id = $1`, [paymentId]);
      console.log('[referral] withdrew %d credit(s) after payment %s was refunded', rowCount, paymentId);
    }
    return { revoked: rowCount };
  } catch (e) {
    console.error('[referral] could not withdraw after refund:', e.message);
    return { revoked: 0 };
  }
}

/* ──────────────────────────────────────────────────────────── for them ── */

/** What the customer sees on their Refer page. */
async function summaryFor(user) {
  if (!await on()) return { enabled: false };
  const link = await ensureLink(user.id);
  const { rows: people } = await db.query(
    `SELECT mobile_masked, status, status_reason, signed_up_at, rewarded_at, expires_at
       FROM gaadipe_referrals WHERE referrer_id = $1 ORDER BY id DESC LIMIT 50`, [user.id]);
  const { rows: credits } = await db.query(
    `SELECT id, expires_at, used_at, used_reg_no, created_at
       FROM report_credits
      WHERE user_id = $1 AND source = 'gaadipe_referral' AND revoked_at IS NULL
      ORDER BY id DESC LIMIT 50`, [user.id]);
  const available = credits.filter((c) => !c.used_at && new Date(c.expires_at) > new Date());
  return {
    enabled: true,
    code: link.code,
    url: linkUrl(link.code),
    wa_url: waUrl(link.code),
    // What to share: the chat when there is one, the website until then.
    share_url: waUrl(link.code) || linkUrl(link.code),
    active: link.is_active,
    joined: people.filter((p) => p.status !== 'expired').length,
    rewarded: people.filter((p) => p.status === 'rewarded').length,
    available: available.length,
    people: people.map((p) => ({ ...p, id: undefined })),
    credits: credits.map((c) => ({ ...c, id: String(c.id) })),
  };
}

module.exports = { ensureLink, linkUrl, waUrl, codeFromText, resolve, attach, onPaid, onRefunded, summaryFor, on };
