/**
 * src/owners/photo.js — "prove this vehicle is yours" with a photo of the RC
 * (user, 2026-10-04).
 *
 * HOW: the customer sends the vehicle number, then a photo of their RC (or the
 * DigiLocker / mParivahan RC PDF) in the same WhatsApp chat. The admin looks
 * at it beside the Government record on the "Verify owners" page and approves
 * or rejects it. The customer waits, and is told the decision on WhatsApp.
 *
 * THE PROMISE, KEPT IN CODE: the photo is stored encrypted (AES-256-GCM) only
 * while it waits, and deleted the moment the admin decides — approved or not.
 * photo_deleted_at is the record that it was. Nothing read from the photo is
 * stored; only the decision.
 *
 * THE OFFER (settings, set on the panel):
 *   owner_verify_reward_on                  the offer is on
 *   owner_verify_free_reports_per_customer  free full reports per customer (1)
 *   owner_verify_free_reports_total         the offer ends after this many (0 = no end)
 *   owner_verify_extend_days                a vehicle with a paid report still
 *                                           running gets these days added instead
 * A customer may verify many vehicles; each gets the badge. The free report
 * goes to the first one(s), up to the per-customer number.
 *
 * TELLING THEM: inside the 24-hour WhatsApp window the decision and the reward
 * go at once. Outside it, the approved template (owner_verify_template_*) says
 * the check is done, if switched on; the full message and the reward follow
 * the next time they write (deliverPending, called on every message).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');
const wa = require('../config').config.whatsapp;

const DIR = path.join(__dirname, '..', 'uploads', 'owner_photos');
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };

const mask = (m) => (m ? `••••••${String(m).slice(-4)}` : null);
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/* ───────────────────────────── encryption ───────────────────────────── */

function key() {
  const secret = process.env.OWNER_PHOTO_KEY
    || `${process.env.WHATSAPP_APP_SECRET || ''}|${process.env.VEHICLE_LOOKUP_KEY || ''}`;
  if (secret.length < 16) throw new Error('no key to encrypt RC photos (set OWNER_PHOTO_KEY)');
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'gaadipe', 'owner-rc-photo/v1', 32));
}
function seal(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function unseal(buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

/* ───────────────────────────── the settings ───────────────────────────── */

const SETTINGS = {
  owner_verification_method: 'photo',
  owner_verify_reward_on: 'true',
  owner_verify_free_reports_per_customer: '1',
  owner_verify_free_reports_total: '100',
  owner_verify_extend_days: '28',
  owner_verify_photos_per_day: '5',
  owner_verify_template_on: 'false',
  owner_verify_template_name: 'owner_verification_update',
  owner_verify_template_language: 'en',
};

async function usePhotos() {
  return String(await settings.get('owner_verification_method', 'photo')).toLowerCase() !== 'details';
}

/** Free reports given (or promised) under the offer: this customer's, and in all. */
async function rewardsUsed(mobile) {
  return db.one(
    `SELECT count(*) FILTER (WHERE mobile = $1)::int AS mine, count(*)::int AS total
       FROM vehicle_owner_claims WHERE reward = 'report' AND status = 'verified'`, [mobile]);
}

/**
 * What this customer would get for verifying `regNo` now:
 * 'report' (free full report), 'extend' (a paid report is running), or 'none'.
 */
async function rewardFor({ userId, mobile, regNo }) {
  if (!await settings.bool('owner_verify_reward_on', true)) return 'none';
  if (userId && regNo && await require('../pay/report').validFor(userId, regNo)) return 'extend';
  const used = await rewardsUsed(mobile);
  const perCustomer = await settings.num('owner_verify_free_reports_per_customer', 1);
  const total = await settings.num('owner_verify_free_reports_total', 100);
  if (used.mine >= perCustomer) return 'none';
  if (total > 0 && used.total >= total) return 'none';
  return 'report';
}

/** The offer in one line, for the invitation (null when there is none). */
async function offerLine({ userId, mobile }) {
  if (!await settings.bool('owner_verify_reward_on', true)) return null;
  const days = await settings.num('owner_verify_extend_days', 28);
  const free = (await rewardFor({ userId: null, mobile, regNo: null })) === 'report';
  return free
    ? `🎁 Your vehicle's *full report — FREE* (already have one running? *+${days} days of alerts, free*)`
    : `🎁 Already have a report running for it? *+${days} days of alerts, free*`;
}

/* ───────────────────────────── the customer ───────────────────────────── */

/** Their vehicles: verified, and waiting for review. */
async function mine(mobile) {
  const { rows } = await db.query(
    `SELECT reg_no, status, verified_at, hidden_at, photo_at FROM vehicle_owner_claims
      WHERE mobile = $1 AND status IN ('verified', 'review') ORDER BY coalesce(verified_at, photo_at) DESC`, [mobile]);
  return { verified: rows.filter((r) => r.status === 'verified'), review: rows.filter((r) => r.status === 'review') };
}

/**
 * Start a photo claim for `regNo`. Returns { ok, claimId } or { ok: false, reason }.
 * reasons: off, already, in_review, too_many
 */
async function begin({ userId, mobile, regNo }) {
  if (!await require('./verify').enabled()) return { ok: false, reason: 'off' };
  const now = await db.one(
    `SELECT status FROM vehicle_owner_claims WHERE mobile = $1 AND reg_no = $2 AND status IN ('verified', 'review') LIMIT 1`, [mobile, regNo]);
  if (now?.status === 'verified') return { ok: false, reason: 'already' };
  if (now?.status === 'review') return { ok: false, reason: 'in_review' };
  const cap = await settings.num('owner_verify_photos_per_day', 5);
  const day = await db.one(
    `SELECT count(*)::int AS n FROM vehicle_owner_claims
      WHERE mobile = $1 AND method = 'rc_photo' AND photo_at > now() - interval '24 hours'`, [mobile]);
  if (day.n >= cap) return { ok: false, reason: 'too_many' };

  // One open claim at a time: an older one still waiting for its photo is closed.
  await db.query(
    `UPDATE vehicle_owner_claims SET status = 'failed', counted = false, note = 'not finished', modified_at = now()
      WHERE mobile = $1 AND status = 'pending'`, [mobile]);
  const v = await db.one(`SELECT id FROM vehicles WHERE reg_no = $1`, [regNo]);
  const row = await db.one(
    `INSERT INTO vehicle_owner_claims (user_id, mobile, vehicle_id, reg_no, method, counted)
     VALUES ($1, $2, $3, $4, 'rc_photo', false) RETURNING id`, [userId || null, mobile, v?.id || null, regNo]);
  return { ok: true, claimId: String(row.id) };
}

/** The photo claim waiting for its photo, if any (the last day). */
async function openClaim(mobile) {
  return db.one(
    `SELECT * FROM vehicle_owner_claims
      WHERE mobile = $1 AND status = 'pending' AND method = 'rc_photo' AND created_at > now() - interval '24 hours'
      ORDER BY id DESC LIMIT 1`, [mobile]);
}

/** Fetch a media file the customer sent, from Meta. */
async function download(mediaId) {
  const auth = { Authorization: `Bearer ${wa.token}` };
  const meta = await fetch(`https://graph.facebook.com/${wa.apiVersion}/${mediaId}`, { headers: auth, signal: AbortSignal.timeout(20000) })
    .then((r) => r.json());
  if (!meta?.url) throw new Error(meta?.error?.message || 'no media url');
  if (Number(meta.file_size) > MAX_BYTES) throw Object.assign(new Error('too big'), { code: 'too_big' });
  const res = await fetch(meta.url, { headers: auth, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`media download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw Object.assign(new Error('too big'), { code: 'too_big' });
  return { buf, mime: String(meta.mime_type || res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() };
}

/**
 * The photo (or PDF) arrived for the open claim. Saved encrypted; the claim
 * goes to review and the admin is told. Returns { ok, regNo } or { ok: false, reason }.
 * reasons: no_claim, not_a_photo, too_big, failed
 */
async function receive(mobile, message) {
  const claim = await openClaim(mobile);
  if (!claim) return { ok: false, reason: 'no_claim' };
  const media = message?.image || message?.document;
  const mime = String(media?.mime_type || '').toLowerCase();
  if (!media?.id || (mime && !TYPES[mime])) return { ok: false, reason: 'not_a_photo', regNo: claim.reg_no };
  let got;
  try {
    got = await download(media.id);
  } catch (e) {
    console.error('[owner-photo] download for claim %s: %s', claim.id, e.message);
    return { ok: false, reason: e.code === 'too_big' ? 'too_big' : 'failed', regNo: claim.reg_no };
  }
  const type = TYPES[got.mime] ? got.mime : (TYPES[mime] ? mime : null);
  if (!type) return { ok: false, reason: 'not_a_photo', regNo: claim.reg_no };

  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${claim.id}.bin`);
  fs.writeFileSync(file, seal(got.buf));
  await db.query(
    `UPDATE vehicle_owner_claims SET status = 'review', photo_path = $2, photo_mime = $3, photo_at = now(), modified_at = now()
      WHERE id = $1`, [claim.id, file, type]);
  await db.query(`INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'owner_photo_received', $3)`,
    [claim.user_id, claim.vehicle_id, JSON.stringify({ claim: String(claim.id), reg_no: claim.reg_no })]).catch(() => {});
  require('../util/adminPing').ping({
    key: `owner_photo:${claim.id}`, severity: 'info', source: 'owners',
    title: '📸 RC photo to verify',
    text: `${mask(mobile)} sent an RC photo for ${claim.reg_no}. Approve or reject it in Verify owners — they are waiting.`,
  }).catch(() => {});
  return { ok: true, regNo: claim.reg_no };
}

/* ───────────────────────────── the admin ───────────────────────────── */

/** Delete the photo — the promise. Safe to call twice. */
async function deletePhoto(claim) {
  if (claim.photo_path) {
    try { fs.rmSync(claim.photo_path, { force: true }); } catch (e) { console.error('[owner-photo] delete %s: %s', claim.id, e.message); }
  }
  await db.query(
    `UPDATE vehicle_owner_claims SET photo_path = NULL, photo_deleted_at = coalesce(photo_deleted_at, now()) WHERE id = $1`, [claim.id]);
}

/** The photo itself, for the admin's eyes. */
async function readPhoto(id) {
  const c = await db.one(`SELECT id, photo_path, photo_mime, status FROM vehicle_owner_claims WHERE id = $1`, [id]);
  if (!c?.photo_path || !fs.existsSync(c.photo_path)) return null;
  return { buf: unseal(fs.readFileSync(c.photo_path)), mime: c.photo_mime || 'image/jpeg' };
}

const REJECT_REASONS = {
  unclear: 'The photo was not clear enough to read',
  not_rc: 'The photo was not of an RC (registration certificate)',
  other_vehicle: 'The RC is for a different vehicle number',
  name: 'The owner name does not match the Government record',
  hidden: 'The vehicle number, owner name or chassis number was covered',
  other: null,
};

/** Waiting for review, and the latest decisions — each beside the Government record. */
async function list({ view = 'review', limit = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT c.id, c.user_id, c.mobile, c.reg_no, c.status, c.photo_at, c.photo_mime, c.photo_path IS NOT NULL AS has_photo,
            c.photo_deleted_at, c.verified_at, c.decided_at, c.reward, c.reward_status, c.notice, c.reject_reason, c.note,
            u.name, a.name AS reviewed_by_name, s.data AS rc,
            (SELECT count(*)::int FROM payments p WHERE p.user_id = c.user_id AND p.status = 'paid' AND p.gateway <> 'free' AND p.amount_paise > 0) AS paid,
            (SELECT count(*)::int FROM vehicle_owner_claims o WHERE o.mobile = c.mobile AND o.status = 'verified') AS owner_of
       FROM vehicle_owner_claims c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN admin_users a ON a.id = c.reviewed_by
       LEFT JOIN vehicles v ON v.reg_no = c.reg_no
       LEFT JOIN vehicle_snapshots s ON s.vehicle_id = v.id AND s.dataset = 'rc'
      WHERE c.method = 'rc_photo' AND ${view === 'review' ? `c.status = 'review'` : `c.status IN ('verified', 'rejected', 'revoked') AND c.photo_at IS NOT NULL`}
      ORDER BY ${view === 'review' ? 'c.photo_at ASC' : 'coalesce(c.decided_at, c.modified_at) DESC'} LIMIT $1`, [limit]);
  const counts = await db.one(
    `SELECT count(*) FILTER (WHERE status = 'review')::int AS review,
            count(*) FILTER (WHERE status = 'verified')::int AS verified,
            count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            count(*) FILTER (WHERE status = 'pending' AND created_at > now() - interval '24 hours')::int AS waiting_photo,
            count(*) FILTER (WHERE reward = 'report' AND status = 'verified')::int AS free_reports,
            count(*) FILTER (WHERE reward = 'extend' AND status = 'verified')::int AS extended
       FROM vehicle_owner_claims WHERE method = 'rc_photo'`);
  const out = [];
  for (const r of rows) {
    const rc = r.rc || {};
    out.push({
      id: String(r.id), reg_no: r.reg_no, status: r.status, name: r.name, masked: mask(r.mobile),
      photo_at: r.photo_at, photo_mime: r.photo_mime, has_photo: r.has_photo, photo_deleted_at: r.photo_deleted_at,
      verified_at: r.verified_at, decided_at: r.decided_at, reward: r.reward, reward_status: r.reward_status,
      notice: r.notice, reject_reason: r.reject_reason, note: r.note, reviewed_by_name: r.reviewed_by_name,
      paid: r.paid, owner_of: r.owner_of,
      // What to compare the photo with — as the Government record holds it.
      record: r.rc ? {
        owner_name: rc.owner_name || null, chassis: rc.chassis || null, engine: rc.engine || null,
        maker: rc.maker || null, model: rc.model || null, colour: rc.colour || null, fuel: rc.fuel || null,
        reg_date: rc.reg_date || null, registered_at: rc.registered_at || null, owner_serial: rc.owner_serial || null,
      } : null,
      // What approving would give them, so the admin knows before tapping.
      reward_if_approved: r.status === 'review' ? await rewardFor({ userId: r.user_id, mobile: r.mobile, regNo: r.reg_no }) : null,
    });
  }
  return { counts, rows: out, reasons: REJECT_REASONS, settings: await getSettings() };
}

/**
 * Approve or reject. The photo is deleted either way, then the customer is
 * told (now, or when they next write). Returns { ok, told } or { ok: false, message }.
 */
async function decide({ id, action, reason, note, adminId, ip }) {
  const c = await db.one(`SELECT * FROM vehicle_owner_claims WHERE id = $1`, [id]);
  if (!c) return { ok: false, message: 'No such claim.' };
  if (c.status !== 'review') return { ok: false, message: 'This one has already been decided.' };
  if (action === 'approve') {
    const other = await db.one(
      `SELECT 1 AS x FROM vehicle_owner_claims WHERE mobile = $1 AND reg_no = $2 AND status = 'verified' AND id <> $3`, [c.mobile, c.reg_no, id]);
    const reward = other ? 'none' : await rewardFor({ userId: c.user_id, mobile: c.mobile, regNo: c.reg_no });
    const v = c.vehicle_id || (await db.one(`SELECT id FROM vehicles WHERE reg_no = $1`, [c.reg_no]))?.id || null;
    await db.query(
      `UPDATE vehicle_owner_claims
          SET status = $5, verified_at = CASE WHEN $5 = 'verified' THEN now() END, decided_at = now(), reviewed_by = $2,
              vehicle_id = coalesce(vehicle_id, $6), reward = $3, reward_status = CASE WHEN $3 = 'none' THEN NULL ELSE 'pending' END,
              notice = 'pending', note = $4, locked_until = NULL, modified_at = now()
        WHERE id = $1`, [id, adminId || null, reward, note ? String(note).slice(0, 300) : 'approved from the RC photo',
        other ? 'rejected' : 'verified', v]);
    await db.query(`INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'owner_verified', $3)`,
      [c.user_id, v, JSON.stringify({ claim: String(id), by: 'rc_photo', reward })]).catch(() => {});
  } else if (action === 'reject') {
    const why = REJECT_REASONS[reason] || (reason ? String(reason).slice(0, 200) : null) || REJECT_REASONS.unclear;
    await db.query(
      `UPDATE vehicle_owner_claims SET status = 'rejected', decided_at = now(), reviewed_by = $2, reject_reason = $3,
              note = $4, reward = 'none', notice = 'pending', modified_at = now() WHERE id = $1`,
      [id, adminId || null, why, note ? String(note).slice(0, 300) : null]);
    await db.query(`INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'owner_verify_failed', $3)`,
      [c.user_id, c.vehicle_id, JSON.stringify({ claim: String(id), by: 'rc_photo', reason: why })]).catch(() => {});
  } else {
    return { ok: false, message: 'Unknown action.' };
  }
  await deletePhoto(c);
  await require('../admin/alerts').clear(`owner_photo:${id}`, `Decided: ${action}`).catch(() => {});
  await require('../admin/auth').audit({ adminId, action: `owner_photo_${action}`, ip,
    detail: { claim: String(id), reg_no: c.reg_no, mobile: mask(c.mobile), reason: reason || null } });
  const told = await deliverPending(c.mobile).catch((e) => {
    console.error('[owner-photo] telling %s: %s', mask(c.mobile), e.message);
    return { sent: 0 };
  });
  return { ok: true, told };
}

async function getSettings() {
  const out = {};
  for (const [k, d] of Object.entries(SETTINGS)) out[k] = String(await settings.get(k, d));
  out.flag_on = await require('./verify').enabled();
  return out;
}

async function saveSettings(changes = {}, adminId) {
  const keys = Object.keys(changes).filter((k) => k in SETTINGS);
  const clean = {};
  for (const k of keys) {
    let v = String(changes[k] ?? '').trim();
    if (k === 'owner_verification_method') v = v === 'details' ? 'details' : 'photo';
    else if (/_on$/.test(k)) v = v === 'true' ? 'true' : 'false';
    else if (/_name$/.test(k)) v = v.replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 100);
    else if (/_language$/.test(k)) v = v.replace(/[^a-z_]/gi, '').slice(0, 10) || 'en';
    else {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 0 || n > 10000) throw Object.assign(new Error(`${k} must be a number from 0 to 10000.`), { status: 400 });
      v = String(n);
    }
    clean[k] = v;
  }
  for (const [k, v] of Object.entries(clean)) {
    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [k, v]);
  }
  await settings.refresh?.();
  await require('../admin/auth').audit({ adminId, action: 'owner_verify_settings', detail: clean });
  return getSettings();
}

/* ───────────────────────────── telling them ───────────────────────────── */

/** Add `days` to a running paid report: its download, the subscription and the watch. */
async function extend(c, days) {
  const add = `${Math.max(1, Number(days) || 28)} days`;
  const reps = await db.query(
    `UPDATE vehicle_reports SET valid_until = valid_until + $3::interval, owner_verified_at = coalesce(owner_verified_at, now()), pdf_layout = 0
      WHERE user_id = $1 AND reg_no = $2 AND valid_until > now() RETURNING *`, [c.user_id, c.reg_no, add]);
  if (c.vehicle_id) {
    await db.query(
      `UPDATE subscriptions SET ends_on = ends_on + $3::interval, modified_at = now()
        WHERE user_id = $1 AND vehicle_id = $2 AND is_active`, [c.user_id, c.vehicle_id, add]);
    await db.query(
      `UPDATE watches SET expires_on = expires_on + $3::interval, expires_at = expires_at + $3::interval, modified_at = now()
        WHERE user_id = $1 AND vehicle_id = $2 AND is_active`, [c.user_id, c.vehicle_id, add]);
  }
  return reps.rows.sort((a, b) => b.id - a.id)[0] || null;
}

/** Give the reward. Returns { given, until?, report? } — given false to try again later. */
async function giveReward(c) {
  const days = await settings.num('owner_verify_extend_days', 28);
  const reports = require('../pay/report');
  let kind = c.reward;
  // Bought one in the meantime: the free report becomes the extension.
  if (kind === 'report' && c.user_id && await reports.validFor(c.user_id, c.reg_no)) kind = 'extend';
  if (kind === 'extend') {
    const r = await extend(c, days);
    if (!r) return { given: false, why: 'nothing running' };
    await require('../whatsapp/flow')._sendValidReport(c.mobile, r).catch(() => {});
    return { given: true, kind, until: r.valid_until };
  }
  if (kind !== 'report') return { given: true, kind: 'none' };

  // The free report goes through exactly the paid path (pay/free.js). If an
  // earlier try made the ₹0 payment but could not issue the report (records
  // server down), that same payment is delivered rather than a second one made.
  const prior = c.reward_payment_id || null;
  let out;
  if (prior) {
    out = await require('../routes/payments').deliverPaidReport(prior, { withText: false });
  } else {
    if (!await db.one(`SELECT 1 AS x FROM vehicles WHERE reg_no = $1`, [c.reg_no])) {
      const data = await require('../vehicle/gateway').full(c.reg_no).catch(() => null);
      if (data?.success) await require('../vehicle/store').record(c.user_id, data).catch(() => {});
    }
    out = await require('../pay/free').issueFree({ userId: c.user_id, regNo: c.reg_no, source: 'owner_verified', reason: 'owner verified (RC photo)' });
    if (out.paymentId) {
      await db.query(`UPDATE vehicle_owner_claims SET checks = checks || $2::jsonb WHERE id = $1`,
        [c.id, JSON.stringify({ reward_payment: String(out.paymentId) })]);
    }
    if (out.already) {
      const r = await extend(c, days);
      return r ? { given: true, kind: 'extend', until: r.valid_until } : { given: true, kind: 'none' };
    }
  }
  return out.ok ? { given: true, kind: 'report', report: out.report } : { given: false, why: out.error || out.reason };
}

const BENEFITS = (days) => [
  '🏅 *Owner verified* seal on your vehicle report',
  `🔔 Alerts before insurance, PUC, tax or fitness run out — and the moment a challan appears`,
  '🛡️ You can *hide your vehicle* from other people\'s checks',
  '🤝 *Coming soon:* people can reach you about your vehicle — without ever seeing your number',
].join('\n');

/**
 * Tell this customer every decision they have not heard yet, and give what
 * was promised. Called when the admin decides and on every message they send.
 * Returns { sent }.
 */
async function deliverPending(mobile) {
  const { rows } = await db.query(
    `SELECT *, (checks->>'reward_payment')::bigint AS reward_payment_id FROM vehicle_owner_claims
      WHERE mobile = $1 AND method = 'rc_photo' AND (notice IN ('pending', 'template') OR reward_status = 'pending')
      ORDER BY decided_at`, [mobile]);
  if (!rows.length) return { sent: 0 };
  const send = require('../whatsapp/send');
  const open = await send.windowOpen(mobile);

  if (!open) {
    // Shut window: only the approved template can reach them, and only once.
    const pending = rows.filter((r) => r.notice === 'pending');
    if (pending.length && await settings.bool('owner_verify_template_on', false)) {
      const name = String(await settings.get('owner_verify_template_name', 'owner_verification_update'));
      const language = String(await settings.get('owner_verify_template_language', 'en'));
      for (const c of pending) {
        const u = await db.one(`SELECT name FROM users WHERE id = $1`, [c.user_id]).catch(() => null);
        const out = await send.template(mobile, name, [
          u?.name || 'there', c.reg_no, c.status === 'verified' ? 'approved ✅' : 'not approved',
        ], { language }).catch((e) => ({ ok: false, error: e.message }));
        if (out.ok) await db.query(`UPDATE vehicle_owner_claims SET notice = 'template' WHERE id = $1`, [c.id]);
        else console.error('[owner-photo] template to %s: %s', mask(mobile), out.error);
      }
    }
    return { sent: 0, waiting: true };
  }

  const days = await settings.num('owner_verify_extend_days', 28);
  let sent = 0;
  for (const c of rows) {
    if (c.status === 'rejected' || c.status === 'revoked') {
      if (c.notice !== 'sent') {
        await send.buttons(mobile,
          `❌ *We could not verify ${c.reg_no}* from that photo.\n\n`
          + `*Reason:* ${c.reject_reason || 'the photo could not be matched with the Government record'}.\n\n`
          + '🗑️ As promised, your photo has been *deleted*.\n\n'
          + 'You are welcome to try again — send a clear photo of the RC showing the *vehicle number*, *owner name* and *chassis number*.',
          [{ id: `ownv:${c.reg_no}`, title: 'Try again' }, { id: 'menu', title: 'More' }]);
        await db.query(`UPDATE vehicle_owner_claims SET notice = 'sent' WHERE id = $1`, [c.id]);
        sent += 1;
      }
      continue;
    }
    if (c.status !== 'verified') continue;

    const justTold = c.notice !== 'sent';
    if (justTold) {
      const lead = `🎉 *Congratulations — you are a verified owner!* ✅\n\n*${c.reg_no}* is confirmed as yours. It matched the Government record.\n\n`;
      const what = {
        report: `🎁 *Your full report is coming next — FREE.* It carries the *Owner verified* seal, with insurance, PUC, tax, fitness and every challan, and ${days} days of alerts.\n\n`,
        extend: `🎁 Your report is already running, so we have *extended it by ${days} days, free*. Here it is again — now with the *Owner verified* seal.\n\n`,
      }[c.reward] || '';
      await send.text(mobile, `${lead}${what}*As a verified owner you get:*\n${BENEFITS(days)}\n\n🗑️ As promised, your RC photo has been *deleted*. We keep only the result.`);
      await db.query(`UPDATE vehicle_owner_claims SET notice = 'sent' WHERE id = $1`, [c.id]);
      sent += 1;
    }
    if (c.reward_status === 'pending') {
      const g = await giveReward(c).catch((e) => ({ given: false, why: e.message }));
      if (g.given) {
        await db.query(`UPDATE vehicle_owner_claims SET reward_status = 'given', reward_at = now(), reward = $2 WHERE id = $1`, [c.id, g.kind]);
        if (g.kind === 'extend' && g.until) {
          await send.text(mobile, `🔔 Alerts for *${c.reg_no}* now run until *${fmtDate(g.until)}*.`);
        }
      } else {
        console.error('[owner-photo] reward for claim %s not given yet: %s', c.id, g.why);
        if (justTold) {
          await send.text(mobile, `⏳ Your free report for *${c.reg_no}* will be sent here as soon as the Government records server answers — no need to ask again.`);
        }
      }
    }
    if (justTold) await send.buttons(mobile, `Would you like to hide *${c.reg_no}* from other people's checks? You can change this any time.`,
      [{ id: 'owner_hide', title: 'Hide from others' }, { id: 'check_another', title: 'Check vehicle' }]).catch(() => {});
    await db.query(
      `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1`,
      [mobile, JSON.stringify({ ov_reg: c.reg_no })]).catch(() => {});
  }
  return { sent };
}

/**
 * The safety net: a photo still on disk for a claim that is no longer waiting
 * for review (decided, or a claim closed some other way) is deleted.
 */
async function sweep() {
  const { rows } = await db.query(
    `SELECT * FROM vehicle_owner_claims WHERE photo_path IS NOT NULL AND status <> 'review'`);
  for (const c of rows) await deletePhoto(c);
  return rows.length;
}

module.exports = {
  usePhotos, begin, openClaim, receive, mine, offerLine, rewardFor, list, decide, readPhoto,
  deliverPending, getSettings, saveSettings, sweep, REJECT_REASONS,
  _test: { seal, unseal },
};
