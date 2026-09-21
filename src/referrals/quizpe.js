/**
 * src/referrals/quizpe.js — refer QuizPe to a parent, get a free full report
 * (user, 2026-09-21).
 *
 *   create()   the customer enters a parent's name and number and ticks that the
 *              parent agrees; the checks below run; the customer then shares
 *              from their OWN phone — GaadiPe and QuizPe send the parent nothing
 *   check()    every few minutes: for each pending referral, QuizPe is asked
 *              (read-only) whether that number joined AFTER the referral and
 *              bought premium (Rs.99+) within the window; if so the referrer
 *              gets a free-report credit
 *   useCredit() the customer spends a credit on a vehicle (pay/free.js)
 *
 * THE CHECKS (fraud, fairness, privacy):
 *   not the referrer's own number · one open referral per number, first
 *   referrer wins · at most referral_pending_max open at once · a burst is a
 *   security event · the parent must be NEW to QuizPe (joined after the
 *   referral) · premium only (captured payment, no trial) · paid within
 *   referral_window_days · referral_monthly_cap rewards a month · blocked or
 *   closed accounts earn nothing · credits expire · the raw number is deleted
 *   when the referral ends, only a masked one is kept.
 */

const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');
const blocks = require('../admin/blocks');
const quizpe = require('../quizpe/readonly');

const CONSENT_TEXT = 'I know this person and they are happy for me to share their mobile number with GaadiPe '
  + 'for this referral. GaadiPe and QuizPe will never message them.';

const digits = (m) => String(m || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '').slice(-10);
const hash = (m) => crypto.createHash('sha256').update(`gaadipe-referral|${m}`).digest('hex');
const mask = (m) => `${m.slice(0, 2)}xxxxx${m.slice(7)}`;
const on = async () => String(await settings.get('referral_enabled', 'true')).toLowerCase() !== 'false';

/** IST month start, for the monthly cap. */
const monthStartSql = `date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`;

async function create(user, { name, mobile, consent }, req = null) {
  if (!(await on())) return { ok: false, error: 'off', message: 'Referrals are paused right now.' };
  const m = digits(mobile);
  if (!/^[6-9]\d{9}$/.test(m)) return { ok: false, error: 'bad_mobile', message: 'Please enter a valid 10-digit Indian mobile number.' };
  if (consent !== true) return { ok: false, error: 'consent', message: 'Please confirm that this person is happy for you to share their number.' };
  const cleanName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (cleanName.length < 2) return { ok: false, error: 'bad_name', message: 'Please enter their name.' };
  if (m === digits(user.mobile)) return { ok: false, error: 'self', message: 'You cannot refer your own number.' };
  if (await blocks.isBlocked('mobile', user.mobile)) return { ok: false, error: 'blocked', message: 'Referrals are not available on this account.' };

  const h = hash(m);
  const taken = await db.one(
    `SELECT referrer_id FROM quizpe_referrals
      WHERE mobile_hash = $1 AND (status IN ('pending', 'rewarded'))`, [h]);
  if (taken) {
    return { ok: false, error: 'already_referred',
      message: taken.referrer_id === user.id ? 'You have already referred this number.' : 'This number has already been referred by someone else.' };
  }

  const pendingMax = await settings.num('referral_pending_max', 10);
  const open = await db.one(
    `SELECT count(*)::int AS n FROM quizpe_referrals WHERE referrer_id = $1 AND status = 'pending'`, [user.id]);
  if (open.n >= pendingMax) {
    return { ok: false, error: 'too_many_pending',
      message: `You have ${open.n} invitations waiting. When some of them join QuizPe or expire, you can invite more.` };
  }

  // A burst of referrals is how bulk-farming looks; it is recorded (and emailed).
  const recent = await db.one(
    `SELECT count(*)::int AS n FROM quizpe_referrals WHERE referrer_id = $1 AND created_at > now() - interval '10 minutes'`, [user.id]);
  if (recent.n >= 5) {
    if (req) await require('../security/guard').record('referral_burst', req, { surface: 'site', detail: { referrals_10m: recent.n + 1 } });
    return { ok: false, error: 'slow_down', message: 'That is a lot of invitations at once. Please try again in a few minutes.' };
  }

  const days = await settings.num('referral_window_days', 30);
  const row = (await db.query(
    `INSERT INTO quizpe_referrals (referrer_id, parent_name, parent_mobile, mobile_masked, mobile_hash,
                                   consent_text, expires_at, ip)
          VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval, $8) RETURNING *`,
    [user.id, cleanName, m, mask(m), h, CONSENT_TEXT, String(days), req?.ip || null])).rows[0];
  await db.query(
    `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'referral_created', $2)`,
    [user.id, JSON.stringify({ referral_id: String(row.id), mobile: row.mobile_masked, consent: CONSENT_TEXT })]);
  return { ok: true, referral: shape(row) };
}

const shape = (r) => ({
  id: String(r.id), name: r.parent_name, mobile: r.mobile_masked, status: r.status,
  created_at: r.created_at, expires_at: r.expires_at, rewarded_at: r.rewarded_at,
  // The number itself, while pending, so the customer's own "remind" button can
  // open their WhatsApp to it. It is their own contact; it goes nowhere else.
  share_to: r.status === 'pending' ? r.parent_mobile : null,
});

async function listFor(userId) {
  const { rows } = await db.query(
    `SELECT * FROM quizpe_referrals WHERE referrer_id = $1 ORDER BY id DESC LIMIT 100`, [userId]);
  const credits = await db.query(
    `SELECT id, source, expires_at, used_at, used_reg_no, created_at FROM report_credits
      WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id DESC LIMIT 100`, [userId]);
  return {
    referrals: rows.map(shape),
    credits: credits.rows.map((c) => ({ ...c, id: String(c.id),
      state: c.used_at ? 'used' : new Date(c.expires_at) < new Date() ? 'expired' : 'available' })),
    available: credits.rows.filter((c) => !c.used_at && new Date(c.expires_at) > new Date()).length,
  };
}

async function availableCredits(userId) {
  const r = await db.one(
    `SELECT count(*)::int AS n FROM report_credits
      WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [userId]);
  return r.n;
}

/* ──────────────────────────────────────────────────────── the QuizPe check ── */

async function end(id, status, reason) {
  await db.query(
    `UPDATE quizpe_referrals SET status = $2, status_reason = $3, parent_mobile = NULL, last_checked_at = now()
      WHERE id = $1`, [id, status, reason]);
}

async function grant(ref, pay) {
  const cap = await settings.num('referral_monthly_cap', 10);
  const validDays = await settings.num('referral_credit_valid_days', 90);
  return db.tx(async (c) => {
    const locked = (await c.query(`SELECT * FROM quizpe_referrals WHERE id = $1 FOR UPDATE`, [ref.id])).rows[0];
    if (!locked || locked.status !== 'pending') return { granted: false };
    // One QuizPe payment rewards once, whoever referred.
    const used = (await c.query(`SELECT 1 FROM quizpe_referrals WHERE quizpe_payment = $1 LIMIT 1`, [pay.payment_id])).rows[0];
    if (used) {
      await c.query(`UPDATE quizpe_referrals SET status = 'not_eligible', status_reason = 'payment already rewarded', parent_mobile = NULL WHERE id = $1`, [ref.id]);
      return { granted: false };
    }
    const month = (await c.query(
      `SELECT count(*)::int AS n FROM report_credits
        WHERE user_id = $1 AND source = 'referral' AND created_at >= ${monthStartSql}`, [ref.referrer_id])).rows[0].n;
    const base = `quizpe_parent_id = $2, quizpe_payment = $3, quizpe_amount = $4, parent_mobile = NULL, last_checked_at = now()`;
    if (month >= cap) {
      await c.query(`UPDATE quizpe_referrals SET status = 'not_eligible', status_reason = 'monthly limit reached', ${base} WHERE id = $1`,
        [ref.id, pay.parent_id, pay.payment_id, pay.amount]);
      return { granted: false, capped: true };
    }
    await c.query(`UPDATE quizpe_referrals SET status = 'rewarded', rewarded_at = now(), ${base} WHERE id = $1`,
      [ref.id, pay.parent_id, pay.payment_id, pay.amount]);
    const credit = (await c.query(
      `INSERT INTO report_credits (user_id, source, referral_id, reward, expires_at)
            VALUES ($1, 'referral', $2, $3, now() + ($4 || ' days')::interval) RETURNING *`,
      [ref.referrer_id, ref.id, String(await settings.get('referral_reward', 'free_report')), String(validDays)])).rows[0];
    await c.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'referral_rewarded', $2)`,
      [ref.referrer_id, JSON.stringify({ referral_id: String(ref.id), credit_id: String(credit.id),
        quizpe_payment: pay.payment_id, amount: String(pay.amount), mobile: ref.mobile_masked })]);
    return { granted: true, credit };
  });
}

/**
 * One pass. Returns counts. Safe to run as often as you like; QuizPe unreachable
 * means this pass does nothing and the next one tries again.
 */
async function check() {
  if (!(await on())) return { off: true };
  // Ended referrals lose the raw number.
  const expired = await db.query(
    `UPDATE quizpe_referrals SET status = 'expired', status_reason = 'not joined in time', parent_mobile = NULL
      WHERE status = 'pending' AND expires_at <= now() RETURNING id`);
  if (!quizpe.configured()) return { expired: expired.rowCount, skipped: 'QuizPe read-only access not configured' };

  const { rows: pending } = await db.query(
    `SELECT r.*, u.mobile AS referrer_mobile, u.deactivated_at
       FROM quizpe_referrals r JOIN users u ON u.id = r.referrer_id
      WHERE r.status = 'pending' AND r.parent_mobile IS NOT NULL ORDER BY r.id LIMIT 500`);
  if (!pending.length) return { expired: expired.rowCount, checked: 0 };

  const minRupees = await settings.num('referral_min_quizpe_rupees', 99);
  let found;
  try {
    found = await quizpe.lookup([...new Set(pending.map((r) => r.parent_mobile))], minRupees);
  } catch (e) {
    console.warn('[referrals] QuizPe lookup failed, will retry: %s', e.message);
    return { expired: expired.rowCount, error: e.message };
  }

  let rewarded = 0; let ineligible = 0;
  for (const ref of pending) {
    const since = new Date(ref.created_at);
    const parents = found.parents.filter((p) => p.mobile === ref.parent_mobile);
    // Already a QuizPe parent before the referral: they would have been anyway.
    if (parents.some((p) => new Date(p.created_at) < since)) {
      await end(ref.id, 'not_eligible', 'already registered with QuizPe'); ineligible += 1; continue;
    }
    const pay = found.payments.find((p) => p.mobile === ref.parent_mobile
      && new Date(p.paid_at) >= since && new Date(p.paid_at) <= new Date(ref.expires_at));
    if (!pay) { await db.query(`UPDATE quizpe_referrals SET last_checked_at = now() WHERE id = $1`, [ref.id]); continue; }
    if (ref.deactivated_at || await blocks.isBlocked('mobile', ref.referrer_mobile)) {
      await end(ref.id, 'not_eligible', 'referrer account blocked or closed'); ineligible += 1; continue;
    }
    const g = await grant(ref, pay);
    if (g.granted) { rewarded += 1; await notifyReward(ref, g.credit).catch((e) => console.warn('[referrals] reward email:', e.message)); }
  }
  if (rewarded || ineligible || expired.rowCount) {
    console.log('[referrals] checked %d · rewarded %d · not eligible %d · expired %d', pending.length, rewarded, ineligible, expired.rowCount);
  }
  return { checked: pending.length, rewarded, ineligible, expired: expired.rowCount };
}

/** The referrer hears about it: on the site (credits list and banner) and by email. */
async function notifyReward(ref, credit) {
  const u = await db.one(`SELECT * FROM users WHERE id = $1`, [ref.referrer_id]);
  if (!u?.email || !u.email_verified_at || u.email_unsubscribed_at) return;
  const C = require('../mail/customer');
  const mail = C.rewardMail(u, { parentName: ref.parent_name, expiresAt: credit.expires_at });
  const row = (await db.query(
    `INSERT INTO customer_emails (user_id, kind, to_email, subject, attempts) VALUES ($1, 'reward', $2, $3, 1) RETURNING id`,
    [u.id, u.email, mail.subject])).rows[0];
  const out = await C.deliver(u.email, mail, u.email_token);
  await db.query(`UPDATE customer_emails SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1`,
    [row.id, out.ok ? 'sent' : out.skipped ? 'skipped' : 'failed', out.ok ? null : String(out.error || '').slice(0, 500)]);
  if (out.ok) await db.query(`UPDATE report_credits SET notified_at = now() WHERE id = $1`, [credit.id]);
}

/* ─────────────────────────────────────────────────────────── use a credit ── */

async function useCredit(user, regNo, { declaration, ctx }) {
  // Claimed first, so two taps cannot spend one credit twice; given back if the
  // report could not be issued.
  const credit = (await db.query(
    `UPDATE report_credits SET used_at = now(), used_reg_no = $2
      WHERE id = (SELECT id FROM report_credits
                   WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
                   ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [user.id, regNo])).rows[0];
  if (!credit) return { ok: false, error: 'no_credit', message: 'You do not have a free report to use right now.' };
  const out = await require('../pay/free').issueFree({
    userId: user.id, regNo, source: 'referral', creditId: credit.id, declaration, ctx });
  if (!out.ok || out.already) {
    await db.query(`UPDATE report_credits SET used_at = NULL, used_reg_no = NULL WHERE id = $1`, [credit.id]);
    if (out.already) return { ok: true, already: true, report_id: String(out.report.id) };
    return { ok: false, error: out.error,
      message: out.error === 'not_checked' ? 'Please check the vehicle first, then use your free report.'
        : 'The Government records service is busy. Your free report is safe — please try again in a minute.' };
  }
  await db.query(`UPDATE report_credits SET payment_id = $2 WHERE id = $1`, [credit.id, out.paymentId]);
  return { ok: true, report_id: String(out.report.id) };
}

module.exports = { create, listFor, availableCredits, check, useCredit, CONSENT_TEXT, digits, mask };
