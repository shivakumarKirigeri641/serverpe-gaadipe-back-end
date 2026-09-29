/**
 * src/fleet/enquiries.js — fleet owners asking for GaadiPe Fleet (user,
 * 2026-09-29).
 *
 * Fleets are onboarded by hand for now: the owner tells us who they are and
 * how many vehicles, we reply with their plan, dashboard access and a payment
 * link. This is the first step — the WhatsApp "For fleets" tap opens a form
 * (no typing in the chat), and what they send is emailed to
 * fleet_enquiry_emails (support@gaadipe.in), with Reply going straight to them.
 *
 * NOBODY SIGNS IN: the link carries a one-time token made for the WhatsApp
 * number that tapped, like the support form. It expires (fleet_link_hours,
 * 48) and is spent once the form is sent.
 */

const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');

const BASE = () => (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** A fresh link for this WhatsApp number. */
async function linkFor({ userId, mobile }) {
  const hours = await settings.num('fleet_link_hours', 48);
  const token = crypto.randomBytes(24).toString('hex');
  await db.query(
    `INSERT INTO fleet_enquiries (token, user_id, mobile, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [token, userId || null, mobile || null, hours]);
  return { url: `${BASE()}/fleet/${token}`, hours };
}

/** The open enquiry behind a token, or why it cannot be used. */
async function open(token) {
  const row = await db.one(
    `SELECT e.*, coalesce(u.display_name, u.wa_profile_name) AS known_name, u.email AS known_email
       FROM fleet_enquiries e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.token = $1`, [String(token || '')]);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.submitted_at) return { ok: false, reason: 'sent', row };
  if (new Date(row.expires_at) <= new Date()) return { ok: false, reason: 'expired', row };
  return { ok: true, row };
}

/** Check and save what the form sent, then email it. */
async function submit(token, body = {}, { ip, userAgent } = {}) {
  const got = await open(token);
  if (!got.ok) return { ok: false, message: got.reason === 'sent' ? 'This form was already sent — we will be in touch.' : 'This link has expired. Tap "For fleets" in WhatsApp again for a new one.' };

  const f = {
    company: clip(body.company, 120),
    contact_name: clip(body.contact_name, 80),
    email: clip(body.email, 160).toLowerCase(),
    vehicles: Math.floor(Number(body.vehicles)),
    vehicle_list: String(body.vehicle_list || '').toUpperCase().replace(/[^A-Z0-9\s,;\n]/g, '').slice(0, 5000),
    city: clip(body.city, 80),
    gstin: clip(body.gstin, 15).toUpperCase(),
    message: String(body.message || '').trim().slice(0, 2000),
  };
  if (f.company.length < 2) return { ok: false, message: 'Please enter your company or business name.' };
  if (f.contact_name.length < 2) return { ok: false, message: 'Please enter your name.' };
  if (!EMAIL_RE.test(f.email)) return { ok: false, message: 'Please enter a valid email — your plan and reports are sent there.' };
  if (!Number.isFinite(f.vehicles) || f.vehicles < 1 || f.vehicles > 100000) return { ok: false, message: 'Please enter how many vehicles you have.' };
  if (f.gstin && !GSTIN_RE.test(f.gstin)) return { ok: false, message: 'That GSTIN does not look right — check it, or leave it empty.' };

  const row = await db.one(
    `UPDATE fleet_enquiries SET company = $2, contact_name = $3, email = $4, vehicles = $5, vehicle_list = $6,
            city = $7, gstin = $8, message = $9, ip = $10, user_agent = $11, submitted_at = now()
      WHERE id = $1 AND submitted_at IS NULL RETURNING *`,
    [got.row.id, f.company, f.contact_name, f.email, f.vehicles, f.vehicle_list || null,
     f.city || null, f.gstin || null, f.message || null, clip(ip, 64) || null, clip(userAgent, 300) || null]);
  if (!row) return { ok: false, message: 'This form was already sent — we will be in touch.' };

  const mailed = await emailIt(row);
  thankOnWhatsApp(row).catch(() => {});
  return { ok: true, id: String(row.id), email: row.email, mailed: mailed.ok };
}

async function emailIt(row) {
  const T = require('../mail/templates');
  const to = String(await settings.get('fleet_enquiry_emails', 'support@gaadipe.in') || '')
    .split(/[,;\s]+/).filter((s) => /@/.test(s));
  const plates = (row.vehicle_list || '').split(/[\s,;]+/).filter(Boolean);
  const out = await require('../mail/mailer').send({
    to: to.length ? to : undefined,
    replyTo: row.email,
    subject: `🚛 Fleet enquiry · ${row.company} · ${row.vehicles} vehicle${row.vehicles === 1 ? '' : 's'}`,
    ...T.layout({
      badge: { text: 'New fleet enquiry', tone: 'good' },
      title: `${row.company} — ${row.vehicles} vehicle${row.vehicles === 1 ? '' : 's'}`,
      lead: `${row.contact_name} asked about GaadiPe Fleet from WhatsApp. Reply to this email to answer them directly.`,
      note: row.message || undefined,
      sections: [
        { heading: 'Contact', rows: [
          ['Company', row.company], ['Name', row.contact_name], ['Email', row.email],
          ['WhatsApp', row.mobile ? T.mobile(row.mobile) : null], ['City / state', row.city],
          ['GSTIN', row.gstin || 'Not given'],
        ] },
        { heading: 'Fleet', rows: [
          ['Number of vehicles', String(row.vehicles)],
          ['Vehicle numbers given', plates.length ? `${plates.length}: ${plates.slice(0, 60).join(', ')}${plates.length > 60 ? ' …' : ''}` : 'None yet'],
          ['Enquiry no.', `FLEET-${row.id}`],
        ] },
      ],
    }),
  });
  await db.query(`UPDATE fleet_enquiries SET emailed_at = CASE WHEN $2 THEN now() END, email_error = $3 WHERE id = $1`,
    [row.id, Boolean(out.ok), out.ok ? null : String(out.error || '').slice(0, 300)]);
  if (!out.ok) console.warn('[fleet] enquiry %s not emailed: %s', row.id, out.error);
  return out;
}

/** A line back in the chat, free inside the 24-hour window. */
async function thankOnWhatsApp(row) {
  if (!row.mobile) return;
  const send = require('../whatsapp/send');
  await send.text(row.mobile,
    `✅ *Thank you, ${row.contact_name.split(' ')[0]}!*\n\n`
    + `We have your fleet enquiry for *${row.vehicles} vehicle${row.vehicles === 1 ? '' : 's'}* (no. FLEET-${row.id}). `
    + `We will email your plan, dashboard access and payment link to *${row.email}* shortly.`);
}

module.exports = { linkFor, open, submit };
