/**
 * src/referrals/quizpe.js — refer QuizPe with ONE PERSONAL LINK, get a free
 * full report (user, 2026-09-21).
 *
 *   join()      the customer agrees that QuizPe may message them (required for
 *               the programme) and gets their link: gaadipe.in/q/<code>, the same
 *               link for everyone they share it with
 *   resolve()   someone taps the link: if it is active and not the owner's own,
 *               it opens QuizPe's WhatsApp with "Hi QuizPe 👋 (GaadiPe ref
 *               GP-<code>)" typed — the parent presses Send themselves
 *   check()     every few minutes, read-only on QuizPe: which numbers sent a
 *               GP- code (the tap), and did that number buy premium (Rs.99+)
 *               within 30 days after? If so, the link's owner gets a free report
 *   useCredit() the customer spends a free report on a vehicle (pay/free.js)
 *
 * NOTHING IS SENT TO THE PARENT by GaadiPe or QuizPe: they start the chat.
 * GaadiPe never stores a parent's number — a hash to match, a masked form to show.
 *
 * WHO COUNTS: a parent new to QuizPe, lapsed, on a free trial, or who only said
 * "hi" before — anyone who buys premium after opening the link. NOT a parent
 * whose premium plan was running when they opened it (a renewal is not an
 * enrolment), and never the owner's own number. First GaadiPe link used wins.
 *
 * LIMITS: monthly reward cap · one reward per QuizPe payment · credits expire ·
 * blocked or closed accounts, withdrawn consent or a disabled link earn nothing
 * and the link stops working · many different numbers on one link in a day is
 * a security event.
 */

const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');
const blocks = require('../admin/blocks');
const quizpe = require('../quizpe/readonly');

const ALPHABET = '23456789BCDFGHJKLMNPQRTVWXYZ';   // no 0/O, 1/I, 5/S, vowels
const PROGRAMME_CONSENT = 'I agree that QuizPe, a product of ServerPe App Solutions, may send me messages '
  + 'about QuizPe on my mobile number. I can withdraw this at any time from my GaadiPe profile.';

const hash = (m) => crypto.createHash('sha256').update(`gaadipe-referral|${m}`).digest('hex');
const mask = (m) => `${m.slice(0, 2)}xxxxx${m.slice(7)}`;
const digits = (m) => String(m || '').replace(/\D/g, '').slice(-10);
const on = async () => String(await settings.get('referral_enabled', 'true')).toLowerCase() !== 'false';
const monthStartSql = `date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`;
const SITE = () => (process.env.PUBLIC_SITE_URL || 'https://gaadipe.in').replace(/\/+$/, '');

const newCode = () => Array.from(crypto.randomBytes(7), (b) => ALPHABET[b % ALPHABET.length]).join('');

async function linkUrl(code) {
  const base = String(await settings.get('referral_link_base', '') || '').replace(/\/+$/, '') || `${SITE()}/q`;
  return `${base}/${code}`;
}

/** Why a link cannot bring rewards right now, or null. */
async function inactiveReason(link, user) {
  if (!(await on())) return 'paused';
  if (!link || !link.is_active) return 'disabled';
  if (!user || user.deactivated_at) return 'closed';
  if (!user.quizpe_consent_at) return 'no_consent';
  if (await blocks.isBlocked('mobile', user.mobile)) return 'blocked';
  return null;
}

/** Join: record the QuizPe consent (the programme's condition) and make the link. */
async function join(user, { consent, name, email, ip, userAgent } = {}) {
  if (consent !== true) return { ok: false, error: 'consent', message: 'Please agree to receive QuizPe messages to join.' };
  if (await blocks.isBlocked('mobile', user.mobile)) return { ok: false, error: 'blocked', message: 'Referrals are not available on this account.' };
  /* NAME AND EMAIL ARE REQUIRED to join (user, 2026-09-21): rewards are
     announced by email, and a referrer is a named person. Given here if the
     account does not have them yet; a new email is sent its confirmation link. */
  const cleanName = String(name || user.display_name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (cleanName.length < 2) return { ok: false, error: 'name', message: 'Please enter your name to join.' };
  const C = require('../mail/customer');
  const cleanEmail = String(email || user.email || '').trim();
  if (!C.validEmail(cleanEmail)) return { ok: false, error: 'email', message: 'Please enter your email to join — your rewards are announced there.' };
  if (cleanName !== user.display_name) {
    await db.query(`UPDATE users SET display_name = $2, modified_at = now() WHERE id = $1`, [user.id, cleanName]);
  }
  await C.setEmail(user.id, cleanEmail);
  if (!user.quizpe_consent_at) {
    await db.query(
      `UPDATE users SET quizpe_consent_at = now(), quizpe_consent_text = $2, quizpe_consent_withdrawn_at = NULL,
              modified_at = now() WHERE id = $1`, [user.id, PROGRAMME_CONSENT]);
    await db.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'quizpe_consent_given', $2)`,
      [user.id, JSON.stringify({ text: PROGRAMME_CONSENT, via: 'referral_programme', ip, user_agent: userAgent })]);
  }
  await ensureLink(user.id);
  return { ok: true };
}

async function ensureLink(userId) {
  const existing = await db.one(`SELECT * FROM referral_links WHERE user_id = $1`, [userId]);
  if (existing) return existing;
  for (let i = 0; i < 5; i++) {
    const row = await db.one(
      `INSERT INTO referral_links (user_id, code) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING *`, [userId, newCode()]);
    if (row) return row;
    const again = await db.one(`SELECT * FROM referral_links WHERE user_id = $1`, [userId]);
    if (again) return again;
  }
  throw new Error('could not make a referral code');
}

/** Everything the Refer page shows. */
async function summaryFor(user) {
  const u = await db.one(`SELECT * FROM users WHERE id = $1`, [user.id]);
  const link = await db.one(`SELECT * FROM referral_links WHERE user_id = $1`, [user.id]);
  const why = link ? await inactiveReason(link, u) : null;
  const clicks = link ? await db.one(
    `SELECT count(*) FILTER (WHERE outcome = 'opened')::int AS opened FROM referral_clicks WHERE link_id = $1`, [link.id]) : null;
  const { rows } = await db.query(
    `SELECT id, mobile_masked, status, status_reason, tapped_at, expires_at, rewarded_at
       FROM quizpe_referrals WHERE referrer_id = $1 AND link_id IS NOT NULL ORDER BY id DESC LIMIT 100`, [user.id]);
  const credits = await db.query(
    `SELECT id, source, expires_at, used_at, used_reg_no, created_at FROM report_credits
      WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id DESC LIMIT 100`, [user.id]);
  return {
    joined: Boolean(link && u.quizpe_consent_at),
    name: u.display_name || null,
    email: u.email || null,
    email_verified: Boolean(u.email && u.email_verified_at),
    link: link ? { code: link.code, url: await linkUrl(link.code), active: !why, inactive_reason: why,
                   opened: clicks?.opened || 0 } : null,
    consent_text: PROGRAMME_CONSENT,
    referrals: rows.map((r) => ({ ...r, id: String(r.id) })),
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

/**
 * Someone tapped gaadipe.in/q/<code>. `viewer` is the signed-in GaadiPe user
 * on that browser, if any. Returns { ok, wa_url } or { ok: false, reason }.
 */
async function resolve(code, { viewer = null, ip = null, userAgent = null } = {}) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const link = clean ? await db.one(`SELECT * FROM referral_links WHERE code = $1`, [clean]) : null;
  if (!link) return { ok: false, reason: 'unknown' };
  const owner = await db.one(`SELECT * FROM users WHERE id = $1`, [link.user_id]);
  const log = (outcome) => db.query(
    `INSERT INTO referral_clicks (link_id, outcome, ip_hash, user_agent) VALUES ($1, $2, $3, $4)`,
    [link.id, outcome, ip ? crypto.createHash('sha256').update(`click|${ip}`).digest('hex').slice(0, 32) : null,
     userAgent ? String(userAgent).slice(0, 200) : null]).catch(() => {});

  // The owner tapping their own link, signed in on this browser.
  if (viewer && String(viewer.id) === String(link.user_id)) { await log('own_link'); return { ok: false, reason: 'own_link' }; }
  const why = await inactiveReason(link, owner);
  const number = String(process.env.QUIZPE_WHATSAPP_NUMBER || '').replace(/\D/g, '');
  if (why || !number) { await log('inactive'); return { ok: false, reason: why || 'not_configured' }; }
  await log('opened');
  const text = `Hi QuizPe 👋 (GaadiPe ref GP-${link.code})`;
  return { ok: true, wa_url: `https://wa.me/${number}?text=${encodeURIComponent(text)}`, quizpe: 'https://quizpe.in' };
}

/* ──────────────────────────────────────────────────────── the QuizPe check ── */

async function end(id, status, reason) {
  await db.query(`UPDATE quizpe_referrals SET status = $2, status_reason = $3, last_checked_at = now() WHERE id = $1`,
    [id, status, reason]);
}

/** Record the taps (first GaadiPe link per number wins). Returns rows created. */
async function recordTaps(messages) {
  const days = await settings.num('referral_window_days', 30);
  let created = 0;
  for (const m of messages) {
    const mobile = digits(m.mobile);
    if (mobile.length !== 10 || !m.code) continue;
    const link = await db.one(`SELECT l.*, u.mobile AS owner_mobile FROM referral_links l JOIN users u ON u.id = l.user_id WHERE l.code = $1`, [m.code]);
    if (!link) continue;
    const h = hash(mobile);
    if (await db.one(`SELECT 1 FROM quizpe_referrals WHERE mobile_hash = $1 AND link_id IS NOT NULL`, [h])) continue;
    const own = mobile === digits(link.owner_mobile);
    const row = await db.one(
      `INSERT INTO quizpe_referrals (referrer_id, link_id, code, mobile_masked, mobile_hash, tapped_at, expires_at,
                                     status, status_reason)
            VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + ($7 || ' days')::interval, $8, $9)
       ON CONFLICT DO NOTHING RETURNING id`,
      [link.user_id, link.id, link.code, mask(mobile), h, m.created_at, String(days),
       own ? 'not_eligible' : 'pending', own ? 'own number' : null]);
    if (row) created += 1;
  }
  return created;
}

async function grant(ref, pay) {
  const cap = await settings.num('referral_monthly_cap', 10);
  const validDays = await settings.num('referral_credit_valid_days', 90);
  return db.tx(async (c) => {
    const locked = (await c.query(`SELECT * FROM quizpe_referrals WHERE id = $1 FOR UPDATE`, [ref.id])).rows[0];
    if (!locked || locked.status !== 'pending') return { granted: false };
    // One QuizPe payment rewards once.
    if ((await c.query(`SELECT 1 FROM quizpe_referrals WHERE quizpe_payment = $1 LIMIT 1`, [pay.payment_id])).rows[0]) {
      await c.query(`UPDATE quizpe_referrals SET status = 'not_eligible', status_reason = 'payment already rewarded' WHERE id = $1`, [ref.id]);
      return { granted: false };
    }
    const month = (await c.query(
      `SELECT count(*)::int AS n FROM report_credits WHERE user_id = $1 AND source = 'referral' AND created_at >= ${monthStartSql}`,
      [ref.referrer_id])).rows[0].n;
    const base = `quizpe_payment = $2, quizpe_amount = $3, last_checked_at = now()`;
    if (month >= cap) {
      await c.query(`UPDATE quizpe_referrals SET status = 'not_eligible', status_reason = 'monthly limit reached', ${base} WHERE id = $1`,
        [ref.id, pay.payment_id, pay.amount]);
      return { granted: false };
    }
    await c.query(`UPDATE quizpe_referrals SET status = 'rewarded', rewarded_at = now(), ${base} WHERE id = $1`,
      [ref.id, pay.payment_id, pay.amount]);
    const credit = (await c.query(
      `INSERT INTO report_credits (user_id, source, referral_id, reward, expires_at)
            VALUES ($1, 'referral', $2, $3, now() + ($4 || ' days')::interval) RETURNING *`,
      [ref.referrer_id, ref.id, String(await settings.get('referral_reward', 'free_report')), String(validDays)])).rows[0];
    await c.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'referral_rewarded', $2)`,
      [ref.referrer_id, JSON.stringify({ referral_id: String(ref.id), credit_id: String(credit.id),
        quizpe_payment: pay.payment_id, amount: String(pay.amount), mobile: ref.mobile_masked, code: ref.code })]);
    return { granted: true, credit };
  });
}

/** One pass. QuizPe unreachable means this pass does nothing; the next one retries. */
async function check() {
  if (!(await on())) return { off: true };
  const expired = await db.query(
    `UPDATE quizpe_referrals SET status = 'expired', status_reason = 'no premium within the window'
      WHERE status = 'pending' AND expires_at <= now() RETURNING id`);
  if (!quizpe.configured()) return { expired: expired.rowCount, skipped: 'QuizPe read-only access not configured' };

  const days = await settings.num('referral_window_days', 30);
  let taps; let pays;
  try {
    taps = await quizpe.refMessages(new Date(Date.now() - (days + 2) * 86400000));
  } catch (e) {
    console.warn('[referrals] QuizPe read failed, will retry: %s', e.message);
    return { expired: expired.rowCount, error: e.message };
  }
  const created = await recordTaps(taps);

  const { rows: pending } = await db.query(
    `SELECT r.*, u.mobile AS referrer_mobile, u.deactivated_at, u.quizpe_consent_at, l.is_active AS link_active
       FROM quizpe_referrals r JOIN users u ON u.id = r.referrer_id LEFT JOIN referral_links l ON l.id = r.link_id
      WHERE r.status = 'pending' AND r.link_id IS NOT NULL ORDER BY r.id LIMIT 1000`);
  // The numbers are known only from QuizPe's view; they are matched by hash, never stored.
  const mobiles = [...new Set(taps.map((t) => digits(t.mobile)))];
  const byHash = new Map(mobiles.map((m) => [hash(m), m]));
  try {
    pays = await quizpe.premiumPayments(pending.map((r) => byHash.get(r.mobile_hash)).filter(Boolean));
  } catch (e) {
    console.warn('[referrals] QuizPe payments read failed, will retry: %s', e.message);
    return { expired: expired.rowCount, taps: created, error: e.message };
  }

  const minRupees = await settings.num('referral_min_quizpe_rupees', 99);
  const rewards = new Map();   // referrer -> credits granted this pass
  let rewarded = 0; let ineligible = 0;
  for (const ref of pending) {
    const mobile = byHash.get(ref.mobile_hash);
    if (!mobile) { await db.query(`UPDATE quizpe_referrals SET last_checked_at = now() WHERE id = $1`, [ref.id]); continue; }
    const tapped = new Date(ref.tapped_at);
    const mine = pays.filter((p) => p.mobile === mobile);
    // Premium already running when they opened the link: a renewal is not an enrolment.
    const running = mine.some((p) => new Date(p.paid_at) < tapped && p.plan_end_date
      && new Date(p.plan_end_date) >= new Date(tapped.toISOString().slice(0, 10)));
    if (running) { await end(ref.id, 'not_eligible', 'premium already running when the link was opened'); ineligible += 1; continue; }
    const pay = mine.find((p) => new Date(p.paid_at) >= tapped && new Date(p.paid_at) <= new Date(ref.expires_at)
      && Number(p.amount) >= minRupees);
    if (!pay) { await db.query(`UPDATE quizpe_referrals SET last_checked_at = now() WHERE id = $1`, [ref.id]); continue; }
    if (ref.deactivated_at || !ref.quizpe_consent_at || ref.link_active === false
        || await blocks.isBlocked('mobile', ref.referrer_mobile)) {
      await end(ref.id, 'not_eligible', 'referrer link not active'); ineligible += 1; continue;
    }
    const g = await grant(ref, pay);
    if (g.granted) {
      rewarded += 1;
      if (!rewards.has(ref.referrer_id)) rewards.set(ref.referrer_id, []);
      rewards.get(ref.referrer_id).push(g.credit);
    }
  }
  // One email per referrer per pass, however many rewards it brought.
  for (const [referrerId, credits] of rewards) {
    await notifyReward(referrerId, credits).catch((e) => console.warn('[referrals] reward email:', e.message));
  }
  await abuseSignals();
  if (created || rewarded || ineligible || expired.rowCount) {
    console.log('[referrals] taps %d · rewarded %d · not eligible %d · expired %d', created, rewarded, ineligible, expired.rowCount);
  }
  return { taps: created, checked: pending.length, rewarded, ineligible, expired: expired.rowCount };
}

/** Many different numbers on one link in a day looks like a bought list, not friends. */
async function abuseSignals() {
  const limit = await settings.num('referral_taps_per_day_alert', 30);
  const { rows } = await db.query(
    `SELECT link_id, referrer_id, count(*)::int AS n FROM quizpe_referrals
      WHERE link_id IS NOT NULL AND created_at > now() - interval '1 day'
      GROUP BY link_id, referrer_id HAVING count(*) > $1`, [limit]);
  for (const r of rows) {
    await require('../security/guard').record('referral_burst', { ip: `link:${r.link_id}` }, {
      surface: 'site', detail: { link_id: String(r.link_id), referrer_id: String(r.referrer_id), numbers_24h: r.n } });
  }
}

/** The referrer hears about it: on the site, and by email (never the parent). */
async function notifyReward(referrerId, credits) {
  const u = await db.one(`SELECT * FROM users WHERE id = $1`, [referrerId]);
  if (!u?.email || !u.email_verified_at || u.email_unsubscribed_at) return;
  const C = require('../mail/customer');
  const mail = C.rewardMail(u, { count: credits.length, expiresAt: credits[0].expires_at });
  const row = (await db.query(
    `INSERT INTO customer_emails (user_id, kind, to_email, subject, attempts) VALUES ($1, 'reward', $2, $3, 1) RETURNING id`,
    [u.id, u.email, mail.subject])).rows[0];
  const out = await C.deliver(u.email, mail, u.email_token);
  await db.query(`UPDATE customer_emails SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1`,
    [row.id, out.ok ? 'sent' : out.skipped ? 'skipped' : 'failed', out.ok ? null : String(out.error || '').slice(0, 500)]);
  if (out.ok) await db.query(`UPDATE report_credits SET notified_at = now() WHERE id = ANY($1::bigint[])`, [credits.map((c) => c.id)]);
}

/* ─────────────────────────────────────────────────────────── use a credit ── */

async function useCredit(user, regNo, { declaration, ctx }) {
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

/* ─────────────────────────────────────────────────────────────── admin ── */

async function resetLink(userId) {
  const code = newCode();
  const row = await db.one(`UPDATE referral_links SET code = $2, reset_at = now() WHERE user_id = $1 RETURNING *`, [userId, code]);
  return row;
}
async function setLinkActive(userId, active, reason = null) {
  return db.one(`UPDATE referral_links SET is_active = $2, disabled_reason = $3 WHERE user_id = $1 RETURNING *`,
    [userId, active, active ? null : reason]);
}

module.exports = {
  join, summaryFor, availableCredits, resolve, check, useCredit, resetLink, setLinkActive,
  PROGRAMME_CONSENT, hash, mask,
};
