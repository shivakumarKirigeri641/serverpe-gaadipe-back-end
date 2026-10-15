/**
 * src/site/shares.js — SHARE A REPORT'S SUMMARY (user, 2026-10-15: "shareable report — go ahead").
 *
 *   create(userId, reportId)  a link for a PAID report of this customer: gaadipe.in/s/<token>
 *                             (/r/ is the referral link's),
 *                             the same one again if it is still live
 *   view(token)               the public summary, counting the view — or null when the link
 *                             is unknown, switched off, or past the report's download period
 *   revoke(userId, reportId)  switch the customer's link off
 *
 * WHAT A SHARE SHOWS: yes/no results only — the vehicle, insurance / PUC / tax / fitness valid
 * or not, a loan or not, how many challans are pending, which owner, and the date it was
 * checked. Never the owner's name, chassis, engine, a date or an amount, never the PDF: the
 * full report stays the buyer's. Read from the report's own snapshot — no new lookup.
 */

const crypto = require('crypto');
const db = require('../db');

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const newToken = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
const SITE = () => (process.env.PUBLIC_SITE_URL || 'https://gaadipe.in').replace(/\/+$/, '');

/** A share link for one of this customer's paid, still-downloadable reports. */
async function create(userId, reportId) {
  const r = await db.one(
    `SELECT r.id, r.reg_no, r.valid_until FROM vehicle_reports r
       JOIN payments p ON p.id = r.payment_id
      WHERE r.id = $1 AND r.user_id = $2 AND p.status = 'paid' AND p.amount_paise > 0
        AND r.valid_until > now()`, [reportId, userId]);
  if (!r) return { ok: false, error: 'not_shareable' };
  const live = await db.one(
    `SELECT token, expires_at FROM report_shares
      WHERE report_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1`, [r.id]);
  if (live) return { ok: true, reg_no: r.reg_no, token: live.token, url: `${SITE()}/s/${live.token}`, expires_at: live.expires_at, again: true };
  let token = newToken();
  for (let i = 0; i < 3; i += 1) {
    const ins = await db.one(
      `INSERT INTO report_shares (token, report_id, user_id, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO NOTHING RETURNING token, expires_at`, [token, r.id, userId, r.valid_until]);
    if (ins) return { ok: true, reg_no: r.reg_no, token: ins.token, url: `${SITE()}/s/${ins.token}`, expires_at: ins.expires_at };
    token = newToken();
  }
  return { ok: false, error: 'try_again' };
}

async function revoke(userId, reportId) {
  const { rowCount } = await db.query(
    `UPDATE report_shares SET revoked_at = now() WHERE report_id = $1 AND user_id = $2 AND revoked_at IS NULL`, [reportId, userId]);
  return { ok: true, revoked: rowCount };
}

const present = (v) => v != null && String(v).trim() !== '' && !/^(na|n\/a|none|null|-|nil|no)$/i.test(String(v).trim());

/** The public summary. */
async function view(token) {
  if (!/^[2-9A-Z]{6,12}$/.test(String(token || ''))) return null;
  const s = await db.one(
    `SELECT s.id, s.expires_at, s.revoked_at, r.reg_no, r.created_at AS checked_at, r.snapshot
       FROM report_shares s JOIN vehicle_reports r ON r.id = s.report_id WHERE s.token = $1`, [token]);
  if (!s || s.revoked_at || new Date(s.expires_at) <= new Date()) return null;
  await db.query(`UPDATE report_shares SET views = views + 1, last_view_at = now() WHERE id = $1`, [s.id]).catch(() => {});

  const snap = s.snapshot || {};
  const rc = snap.rc || {};
  const view = require('./vehicleView');
  const docs = require('../whatsapp/report').documentsOf(rc).map((d) => ({
    label: d.label, name: d.name, state: d.days < 0 ? 'expired' : d.days <= 30 ? 'due' : 'valid',
  }));
  const year = String(rc.manufactured || rc.reg_date || '').match(/(19|20)\d{2}/)?.[0] || null;
  return {
    reg_no: s.reg_no,
    kind: view.kindOf(rc),
    vehicle: [rc.maker, view.cleanModel(rc.model)].filter(Boolean).join(' · ') || null,
    detail: [rc.fuel, rc.vehicle_class, year].filter(Boolean).join(' · ') || null,
    documents: docs,
    loan: present(rc.financer),
    blacklisted: present(rc.blacklist_status) && !/^(clear|not)/i.test(String(rc.blacklist_status)),
    owner_serial: Number(rc.owner_serial) > 0 ? Number(rc.owner_serial) : null,
    challans_pending: snap.challans ? Number(snap.challans.pending_count || 0) : null,
    rc_active: rc.status ? /^active/i.test(String(rc.status)) : null,
    checked_at: s.checked_at,
    valid_until: s.expires_at,
  };
}

module.exports = { create, revoke, view };
