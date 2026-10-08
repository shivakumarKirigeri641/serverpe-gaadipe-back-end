/**
 * src/jobs/notify.js — emails to the admin, from noreply (user, 2026-09-18).
 *
 * Every 30 seconds it looks for what the admin should hear about and sends each
 * thing ONCE:
 *
 *   sign_in        someone signed in to gaadipe.in — who, from what, from where
 *   payment        a payment succeeded — the money, the split, the documents,
 *                  with the invoice PDF attached
 *   contact        a message from the "Contact us" form
 *   feedback       a feedback note
 *   wa_hi          someone said Hi on WhatsApp
 *   wa_check       a vehicle checked on WhatsApp — found, or not
 *   wa_opt_out     someone replied STOP
 *   left_at_pay    a ₹19 payment link opened and not paid within 30 minutes
 *   daily_summary  the day's figures, once, at 11:55 pm IST (daily_summary_hour_ist)
 *
 * WHY A JOB AND NOT A CALL IN EACH FLOW: a payment is confirmed in four places
 * (checkout, webhook, reconciler, WhatsApp), and a mail server that is slow or
 * down must never hold up any of them. Here the flows only write rows, as they
 * already do; this reads them, and a failed send is simply tried again on a
 * later tick (up to five times). admin_notifications is what guarantees once.
 *
 * Each kind can be switched off in Settings (notify_sign_ins, notify_payments,
 * notify_contact, notify_feedback, notify_wa_hi, notify_wa_checks,
 * notify_wa_opt_out, notify_left_at_payment, daily_summary_email).
 */

const fs = require('fs');
const db = require('../db');
const settings = require('../util/settings');
const mailer = require('../mail/mailer');
const T = require('../mail/templates');
const device = require('../site/device');

const MAX_ATTEMPTS = 5;
const on = async (key) => String(await settings.get(key, 'true')).toLowerCase() !== 'false';

/*
 * Has the day reached this setting's time yet (IST)? The value is a time —
 * "23:55" — or a plain hour, "21", as the older settings were. The daily
 * summaries go at 11:55 pm (user, 2026-10-01) so they cover the whole day.
 */
async function reached(key, fallback) {
  const raw = String(await settings.get(key, fallback) ?? fallback).trim();
  const TIME = /^(\d{1,2})(?:[:.](\d{2}))?$/;
  const m = TIME.exec(raw) || TIME.exec(fallback);
  const at = Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2] || 0));
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return now.getUTCHours() * 60 + now.getUTCMinutes() >= at;
}

/** Claim (kind, ref) for sending; null if it was sent already or has given up. */
async function claim(kind, ref) {
  return db.one(
    `INSERT INTO admin_notifications (kind, ref, attempts) VALUES ($1, $2, 1)
     ON CONFLICT (kind, ref) DO UPDATE SET attempts = admin_notifications.attempts + 1
       WHERE admin_notifications.status <> 'sent' AND admin_notifications.attempts < ${MAX_ATTEMPTS}
     RETURNING id, attempts`, [kind, String(ref)]);
}

async function settle(id, out) {
  await db.query(
    `UPDATE admin_notifications
        SET status = $2, last_error = $3, sent_to = $4, sent_at = CASE WHEN $2 = 'sent' THEN now() END
      WHERE id = $1`,
    [id, out.ok ? 'sent' : 'failed', out.ok ? null : String(out.error || '').slice(0, 500), out.to || null]);
  if (!out.ok) console.warn('[notify] email failed: %s', out.error);
}

async function deliver(kind, ref, build) {
  const row = await claim(kind, ref);
  if (!row) return false;
  let mail;
  try { mail = await build(); } catch (e) { await settle(row.id, { ok: false, error: `build: ${e.message}` }); return false; }
  if (!mail) { await settle(row.id, { ok: true, to: '(nothing to send)' }); return false; }
  const out = await mailer.send(mail);
  await settle(row.id, out);
  return out.ok;
}

/* Rows not yet sent (or still worth retrying) for a kind. */
const notDone = (kind, refExpr) => `NOT EXISTS (SELECT 1 FROM admin_notifications n
   WHERE n.kind = '${kind}' AND n.ref = ${refExpr}
     AND (n.status = 'sent' OR n.attempts >= ${MAX_ATTEMPTS}))`;

/* ───────────────────────────────────────────────── the website (2026-10-07) ── */

/*
 * WEBSITE EMAILS (user, 2026-10-07: "mail trigger to admin, for me"). With
 * WhatsApp gone the website is where customers are, so its moments are emailed
 * the way WhatsApp's were. Each has its own switch, set from the website admin
 * (webadmin.gaadipe.in → Emails):
 *   web_check    a vehicle checked on the website after signing in  notify_web_checks
 *   chat_check   a free check in the chat, without signing in        notify_chat_checks
 *   push_on      a customer allowed notifications on a phone         notify_push_on
 * The button opens the website admin (WEBADMIN_URL).
 */
const WEBADMIN = () => (process.env.WEBADMIN_URL || 'https://webadmin.gaadipe.in').replace(/\/+$/, '');
const SOURCE_NAMES = { google_ads: 'Google Ads', meta_ads: 'Meta ads (Facebook / Instagram)', google: 'Google search',
  organic: 'Other search', social: 'Social media', whatsapp: 'WhatsApp', referral: 'Another website', direct: 'Direct / typed the address' };
const sourceName = (s) => SOURCE_NAMES[s] || (s ? s.replace(/_/g, ' ') : null);

/** Where a customer first came from: the earliest website visitor linked to them. */
async function sourceOfUser(userId) {
  if (!userId) return null;
  const v = await db.one(
    `SELECT coalesce(nullif(first_touch->>'source', ''), 'direct') AS source, first_touch->>'campaign' AS campaign
       FROM visitors WHERE user_id = $1 ORDER BY first_seen_at LIMIT 1`, [userId]).catch(() => null);
  return v ? [sourceName(v.source), v.campaign].filter(Boolean).join(' · ') : 'Not known (no website visit linked)';
}

async function webChecks() {
  if (!(await on('notify_web_checks'))) return 0;
  const { rows } = await db.query(
    `SELECT e.id, e.created_at, e.kind, e.detail, e.user_id FROM event_log e
      WHERE e.kind IN ('vehicle_check', 'vehicle_check_repeat') AND e.detail->>'channel' = 'web'
        AND e.created_at > now() - interval '1 hour' AND ${notDone('web_check', 'e.id::text')}
      ORDER BY e.id LIMIT 30`);
  let n = 0;
  for (const e of rows) {
    const d = e.detail || {};
    n += await deliver('web_check', e.id, async () => {
      const u = await db.one(
        `SELECT u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.email,
                (SELECT count(*) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid')::int AS paid,
                (SELECT count(*) FROM event_log x WHERE x.user_id = u.id AND x.kind IN ('vehicle_check', 'vehicle_check_repeat')
                   AND x.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'))::int AS today
           FROM users u WHERE u.id = $1`, [e.user_id]);
      const v = d.reg_no ? await db.one(`SELECT maker, model, fuel, vehicle_class FROM vehicles WHERE reg_no = $1`, [d.reg_no]) : null;
      const bought = d.reg_no ? await db.one(
        `SELECT 1 AS yes FROM vehicle_reports WHERE user_id = $1 AND reg_no = $2 LIMIT 1`, [e.user_id, d.reg_no]).catch(() => null) : null;
      const kindOf = bought ? 'Repeat check · full report' : e.kind === 'vehicle_check_repeat' ? 'Repeat check · basic' : 'New vehicle';
      const who = u?.name || T.mobile(u?.mobile);
      const outcome = d.found === false ? 'Not found, or the records service failed' : 'Found';
      return {
        // Vehicle number and mobile in the subject and at the top (user, 2026-10-08).
        // ✅ record found · ⚠️ not found or the records service failed (user, 2026-10-08).
        subject: `${d.found === false ? '⚠️' : '✅'} ${d.reg_no || 'Vehicle'} · ${T.mobile(u?.mobile)}${u?.name ? ` · ${u.name}` : ''} · ${kindOf}`,
        ...T.layout({
          badge: { text: `Website check · ${kindOf}`, tone: d.found === false ? 'watch' : bought ? 'good' : 'info' },
          title: `${who} checked ${d.reg_no || 'a vehicle'} on gaadipe.in`,
          lead: `${T.ist(e.created_at)} · ${outcome}.`,
          stats: [['Vehicle', d.reg_no || '—'], ['Mobile', T.mobile(u?.mobile)]],
          sections: [
            { heading: 'Vehicle', rows: [
              ['Number', d.reg_no], ['RTO', d.reg_no ? await rtoLine(d.reg_no) : null],
              ['Make · model', v ? [v.maker, v.model].filter(Boolean).join(' · ') : '—'],
              ['Fuel · type', v ? [v.fuel, v.vehicle_class].filter(Boolean).join(' · ') : '—'],
              ['Result', outcome], ['Check', kindOf],
            ] },
            { heading: 'Who', rows: [
              ['Name', u?.name || 'Not given'], ['Mobile', T.mobile(u?.mobile)], ['Email', u?.email],
              ['Checks today', String(u?.today ?? 0)], ['Paid before', u?.paid ? `Yes (${u.paid})` : 'No'],
              ['Came from', await sourceOfUser(e.user_id)],
            ] },
          ],
          cta: { label: 'Open the website admin', url: `${WEBADMIN()}/web/customers` },
        }),
      };
    }) ? 1 : 0;
  }
  return n;
}

/*
 * SOMEONE ON THE WEBSITE (user, 2026-10-07: "I need a mail when someone taps my
 * website"). One email per visit, about a minute after it starts, so it can say
 * where they came from (Google Ads, search…), on what phone, where, whether they
 * have been before, and what they have done so far. Switch: notify_visits.
 */
async function visits() {
  if (!(await on('notify_visits'))) return 0;
  const { rows } = await db.query(
    `SELECT s.* FROM web_sessions s
      WHERE s.started_at > now() - interval '1 hour' AND s.started_at < now() - interval '60 seconds'
        AND ${notDone('visit', 's.session_id')}
      ORDER BY s.started_at LIMIT 30`);
  let n = 0;
  for (const s of rows) {
    n += await deliver('visit', s.session_id, async () => {
      const before = await db.one(
        `SELECT count(*)::int AS n, min(started_at) AS first FROM web_sessions WHERE visitor_id = $1 AND started_at < $2`,
        [s.visitor_id, s.started_at]);
      const u = s.user_id ? await db.one(
        `SELECT mobile, coalesce(display_name, wa_profile_name) AS name FROM users WHERE id = $1`, [s.user_id]) : null;
      const dev = s.device || {};
      const pl = s.place || {};
      const where = [pl.city, pl.region, pl.country].filter(Boolean).join(', ') || 'Not known';
      const from = [sourceName(s.source || 'direct'), s.campaign].filter(Boolean).join(' · ');
      const again = before?.n ? `Returning — visit ${before.n + 1} (first ${T.ist(before.first)})` : 'First visit';
      const phone = [dev.device_type, dev.os, dev.browser].filter(Boolean).join(' · ') || 'Not known';
      return {
        subject: `👀 ${before?.n ? 'Returning visitor' : 'New visitor'} on gaadipe.in · ${sourceName(s.source || 'direct')}${pl.city ? ` · ${pl.city}` : ''}`,
        ...T.layout({
          badge: { text: before?.n ? 'Returning visitor' : 'New visitor', tone: s.source === 'google_ads' || s.source === 'meta_ads' ? 'good' : 'info' },
          title: `Someone is on gaadipe.in${u ? ` — ${u.name || T.mobile(u.mobile)}` : ''}`,
          lead: `${T.ist(s.started_at)} · from ${from}.`,
          sections: [
            { heading: 'The visit', rows: [
              ['Came from', from], ['Landed on', s.landing || '/'], ['Phone / computer', phone], ['Where', where],
              ['Been before?', again], ['Signed in', u ? `${u.name || 'Yes'} · ${T.mobile(u.mobile)}` : 'Not yet'],
            ] },
            { heading: 'So far', rows: [
              ['Pages', String(s.pages || 0)], ['Taps', String(s.interactions || 0)],
              ['Doing now', s.action || s.step || '—'], ['Visit id', s.session_id],
            ] },
          ],
          cta: { label: 'Watch this visit', url: `${WEBADMIN()}/web/sessions/${encodeURIComponent(s.session_id)}` },
        }),
      };
    }) ? 1 : 0;
  }
  return n;
}

/*
 * A FREE CHECK BEFORE SIGN-IN, IN FULL (user, 2026-10-08: "a mail when a user
 * checks without sign-in, with complete and full details"). One email per
 * lookup — from the audit record (anon_checks, migration 142): the vehicle and
 * what was shown, where and on what device, the IP, session and ids, where they
 * came from, and the words they agreed to. Refused attempts (limits, guard) are
 * not emailed one by one; the email counts them. Switch: notify_chat_checks.
 */
async function chatChecks() {
  if (!(await on('notify_chat_checks'))) return 0;
  const { rows } = await db.query(
    `SELECT a.* FROM anon_checks a
      WHERE a.outcome <> 'refused' AND a.created_at > now() - interval '1 hour'
        AND ${notDone('free_check', 'a.id::text')}
      ORDER BY a.id LIMIT 30`).catch(() => ({ rows: [] }));
  let n = 0;
  for (const a of rows) {
    n += await deliver('free_check', a.id, async () => {
      const d = a.device || {};
      const p = a.place || {};
      const s = a.shown || {};
      const k = a.consent || {};
      const v = a.reg_no ? await db.one(`SELECT maker, model, fuel, vehicle_class FROM vehicles WHERE reg_no = $1`, [a.reg_no]) : null;
      const day = await db.one(
        `SELECT count(*) FILTER (WHERE outcome <> 'refused')::int AS lookups, count(*) FILTER (WHERE outcome = 'refused')::int AS refused,
                count(*) FILTER (WHERE outcome = 'refused' AND (device_id = $1 OR ip = $2))::int AS refused_same
           FROM anon_checks WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`,
        [a.device_id || '', a.ip || '']);
      const place = [p.city, p.region, p.country].filter(Boolean).join(', ') || 'Not known';
      const shownLine = a.outcome === 'shown'
        ? [s.maker, s.model ? `${s.model}${s.variant_hidden ? ' •••' : ''}` : null, s.fuel].filter(Boolean).join(' · ')
        : a.outcome === 'not_found' ? 'No Government record found' : `Failed (${a.refusal || 'records service'})`;
      return {
        // ✅ found and shown · ⚠️ no record · ❌ every source failed (user, 2026-10-08).
        subject: `${a.outcome === 'shown' ? '✅' : a.outcome === 'not_found' ? '⚠️' : '❌'} Free check · ${a.reg_no || 'vehicle'} · ${shownLine} · ${p.city || place}`,
        ...T.layout({
          badge: { text: `Free check before sign-in · ${a.outcome === 'shown' ? 'record found' : a.outcome === 'not_found' ? 'no record' : 'failed'}`,
                   tone: a.outcome === 'shown' ? 'good' : a.outcome === 'not_found' ? 'watch' : 'wrong' },
          title: `A visitor checked ${a.reg_no || 'a vehicle'} without signing in`,
          lead: `${T.ist(a.created_at)} · from ${place} · ${a.source ? `came from ${sourceName(a.source)}` : 'came directly'}. They agreed to the Terms first.`,
          stats: [['Vehicle', a.reg_no || '—'], ['Shown', a.outcome === 'shown' ? 'Yes' : 'No'], ['Free checks today', String(day?.lookups ?? 0)], ['Refused today', String(day?.refused ?? 0)]],
          sections: [
            { heading: 'Vehicle', rows: [
              ['Number', a.reg_no], ['RTO', a.reg_no ? await rtoLine(a.reg_no) : null],
              ['Shown to the visitor', shownLine],
              ['On record (not shown)', v ? [v.maker, v.model, v.fuel, v.vehicle_class].filter(Boolean).join(' · ') : null],
              ['Data from', a.data_source], ['Took', a.latency_ms != null ? `${a.latency_ms} ms` : null],
            ] },
            { heading: 'Where and who', rows: [
              ['Place (from IP)', place], ['IP address', a.ip], ['IP chain', a.ip_chain],
              ['Came from', [sourceName(a.source || 'direct'), a.campaign].filter(Boolean).join(' · ')], ['Referrer', a.referrer], ['Page', a.page],
              ['Refused again today (same device or IP)', day?.refused_same ? String(day.refused_same) : null],
            ] },
            { heading: 'Device', rows: [
              ['Device', [d.type, d.vendor, d.model].filter(Boolean).join(' · ')], ['Operating system', [d.os, d.os_version].filter(Boolean).join(' ')],
              ['Browser', [d.browser, d.browser_version].filter(Boolean).join(' ')], ['Screen · viewport', [d.screen, d.viewport].filter(Boolean).join(' · ')],
              ['Time zone', d.timezone], ['Languages', d.languages], ['Network', d.connection], ['Platform', d.platform],
              ['User agent', a.user_agent],
            ] },
            { heading: 'Ids', rows: [
              ['Record', `#${a.id}`], ['Device id', a.device_id], ['Visitor id', a.visitor_id], ['Session id', a.session_id],
            ] },
            { heading: 'Consent', rows: [
              ['Agreed', k.agreed ? `Yes — tapped “Agree & check” (${k.language === 'hi' ? 'Hindi' : 'English'})` : 'No'],
              ['Words shown', k.words], ['Policy versions', k.versions ? Object.entries(k.versions).map(([x, y]) => `${x} ${y}`).join(' · ') : null],
              ['Lawful purpose', k.lawful_purpose_confirmed ? 'Confirmed' : null],
            ] },
          ],
          cta: { label: 'Open free checks', url: `${WEBADMIN()}/web/free-checks` },
        }),
      };
    }) ? 1 : 0;
  }
  return n;
}

async function pushOn() {
  if (!(await on('notify_push_on'))) return 0;
  const { rows } = await db.query(
    `SELECT c.id, c.user_id, c.created_at, c.device FROM customer_push_subscriptions c
      WHERE c.created_at > now() - interval '1 hour' AND ${notDone('push_on', 'c.id::text')}
      ORDER BY c.id LIMIT 20`).catch(() => ({ rows: [] }));
  let n = 0;
  for (const c of rows) {
    n += await deliver('push_on', c.id, async () => {
      const u = await db.one(`SELECT mobile, coalesce(display_name, wa_profile_name) AS name FROM users WHERE id = $1`, [c.user_id]);
      const who = u?.name || T.mobile(u?.mobile);
      return {
        subject: `🔔 Notifications on · ${who}`,
        ...T.layout({
          badge: { text: 'Allowed notifications', tone: 'good' },
          title: `${who} allowed GaadiPe notifications`,
          lead: `${T.ist(c.created_at)}. GaadiPe can now alert them on this phone, even with the site closed.`,
          sections: [{ heading: 'Who', rows: [
            ['Name', u?.name || 'Not given'], ['Mobile', T.mobile(u?.mobile)],
            ['Device', String(c.device || '').slice(0, 120) || 'Unknown'], ['Came from', await sourceOfUser(c.user_id)],
          ] }],
          cta: { label: 'Open customers', url: `${WEBADMIN()}/web/customers` },
        }),
      };
    }) ? 1 : 0;
  }
  return n;
}

/* ───────────────────────────────────────────────────────────── sign-in ── */

async function signIns() {
  if (!(await on('notify_sign_ins'))) return 0;
  const { rows } = await db.query(
    `SELECT s.* FROM site_sign_ins s
      WHERE s.event = 'signed_in' AND s.created_at > now() - interval '1 hour'
        AND ${notDone('sign_in', 's.id::text')}
      ORDER BY s.id LIMIT 20`);
  let n = 0;
  for (const s of rows) {
    n += await deliver('sign_in', s.id, async () => {
      const u = await db.one(
        `SELECT u.*, coalesce(u.display_name, u.wa_profile_name) AS shown_name,
                (SELECT count(*) FROM site_sessions x WHERE x.user_id = u.id)::int AS sign_ins,
                (SELECT count(*) FROM user_vehicles x WHERE x.user_id = u.id)::int AS vehicles,
                (SELECT coalesce(sum(amount_paise), 0) FROM payments x WHERE x.user_id = u.id AND x.status = 'paid')::bigint AS paid_paise,
                (SELECT max(created_at) FROM site_sessions x WHERE x.user_id = u.id AND x.id <> $2) AS previous_sign_in
           FROM users u WHERE u.id = $1`, [s.user_id, s.session_id || 0]);
      if (!u) return null;
      const isNew = s.outcome === 'new_customer' || u.sign_ins <= 1;
      const cameFrom = await sourceOfUser(u.id);
      const place = device.placeOf(s.city || s.region || s.country ? s : device.locate(s.ip)) || 'Unknown';
      const who = u.shown_name || 'A customer';
      const deviceLine = device.describe(s) || 'Unknown device';
      return {
        subject: `${isNew ? '🆕 New customer' : '🔐 Sign-in'} · ${who} · ${T.mobile(u.mobile)} · ${place}`,
        ...T.layout({
          badge: isNew ? { text: 'New customer signed in', tone: 'good' } : { text: 'Signed in', tone: 'info' },
          title: `${who} signed in to GaadiPe`,
          lead: `${T.mobile(u.mobile)} signed in ${T.ist(s.created_at)} on ${deviceLine}, from ${place}.`,
          stats: [['Sign-ins', String(u.sign_ins)], ['Vehicles', String(u.vehicles)], ['Paid so far', T.rupees(u.paid_paise)]],
          sections: [
            { heading: 'Customer', rows: [
              ['Name', u.shown_name || 'Not given'], ['Mobile', T.mobile(u.mobile)], ['Email', u.email],
              ['Customer since', T.ist(u.created_at)], ['Previous sign-in', u.previous_sign_in ? T.ist(u.previous_sign_in) : 'This is the first'],
              ['Language', u.preferred_language === 'hi' ? 'Hindi' : 'English'],
              ['Came from', cameFrom],
            ] },
            { heading: 'Device', rows: [
              ['Device', [s.device_type, s.device_vendor, s.device_model].filter(Boolean).join(' · ')],
              ['Operating system', [s.os, s.os_version].filter(Boolean).join(' ')],
              ['Browser', [s.browser, s.browser_version].filter(Boolean).join(' ')],
              ['Screen', s.screen], ['Time zone', s.timezone], ['Languages', s.languages], ['Network', s.connection],
              ['Device id', s.device_id],
            ] },
            { heading: 'Network', rows: [
              ['IP address', s.ip], ['Place (approximate)', place], ['Came from', s.referrer], ['User agent', s.user_agent],
            ] },
          ],
          cta: { label: 'Open this customer', path: '/customers' },
        }),
      };
    }) ? 1 : 0;
  }
  return n;
}

/* ───────────────────────────────────────────────────────────── payment ── */

async function payments() {
  if (!(await on('notify_payments'))) return 0;
  // Wait up to three minutes for the invoice, so it can travel with the email.
  const { rows } = await db.query(
    `SELECT p.id FROM payments p
      WHERE p.status = 'paid' AND p.paid_at > now() - interval '1 day'
        AND p.gateway <> 'free'  -- a free report (referral / owner grant) is not a payment
        AND coalesce(p.raw->>'channel', p.raw->'paid_from'->>'channel', 'whatsapp') = 'web'  -- website payments only (2026-10-07)
        AND (EXISTS (SELECT 1 FROM invoices i WHERE i.payment_id = p.id) OR p.paid_at < now() - interval '3 minutes')
        AND ${notDone('payment', 'p.id::text')}
      ORDER BY p.id LIMIT 10`);
  let n = 0;
  for (const { id } of rows) {
    n += await deliver('payment', id, async () => {
      const p = await db.one(
        `SELECT p.*, pl.name AS plan_name, pl.kind AS plan_kind, pl.duration_days,
                u.mobile, u.email, coalesce(u.display_name, u.wa_profile_name) AS shown_name, u.created_at AS customer_since,
                (SELECT count(*) FROM payments x WHERE x.user_id = p.user_id AND x.status = 'paid')::int AS paid_count,
                (SELECT coalesce(sum(amount_paise), 0) FROM payments x WHERE x.user_id = p.user_id AND x.status = 'paid')::bigint AS lifetime_paise
           FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN plans pl ON pl.id = p.plan_id
          WHERE p.id = $1`, [id]);
      if (!p) return null;
      const inv = await db.one(`SELECT * FROM invoices WHERE payment_id = $1 ORDER BY id DESC LIMIT 1`, [id]);
      const rep = await db.one(`SELECT * FROM vehicle_reports WHERE payment_id = $1 ORDER BY id DESC LIMIT 1`, [id]);
      const veh = await db.one(
        `SELECT reg_no, maker, model, fuel, vehicle_class FROM vehicles
          WHERE id = coalesce($1::bigint, $2::bigint)`, [p.raw?.vehicle_id || null, rep?.vehicle_id || null]);
      const decl = await db.one(
        `SELECT id, detail, created_at FROM event_log WHERE kind = 'purchase_consent' AND detail->>'payment_row' = $1
          ORDER BY id DESC LIMIT 1`, [String(id)]);
      const { splitOf } = require('../admin/stats');
      const split = await splitOf(p.amount_paise);
      const channel = p.raw?.channel === 'web' || decl?.detail?.channel === 'web' ? 'Website' : 'WhatsApp';

      const attachments = [];
      if (inv?.pdf_path && fs.existsSync(inv.pdf_path)) {
        attachments.push({ filename: `${inv.invoice_number}.pdf`, path: inv.pdf_path, contentType: 'application/pdf' });
      }
      const who = p.shown_name || T.mobile(p.mobile);
      return {
        // Vehicle number and mobile in the subject (user, 2026-10-08).
        subject: `✅ Payment received · ${T.rupees(p.amount_paise)} · ${veh?.reg_no || p.plan_name || 'GaadiPe'} · ${T.mobile(p.mobile)}${p.shown_name ? ` · ${p.shown_name}` : ''}`,
        attachments,
        ...T.layout({
          badge: { text: 'Payment successful', tone: 'good' },
          title: `${T.rupees(p.amount_paise)} received${veh?.reg_no ? ` for ${veh.reg_no}` : ''} · ${T.mobile(p.mobile)}${p.shown_name ? ` (${p.shown_name})` : ''}`,
          lead: `${p.plan_name || 'Full vehicle report'}${veh?.reg_no ? ` for ${veh.reg_no}` : ''}, paid ${T.ist(p.paid_at)} on the ${channel.toLowerCase()}.`
            + (attachments.length ? ' The tax invoice is attached.' : ''),
          stats: [['Amount', T.rupees(p.amount_paise)], ['Take-home', T.rupees(split.take_home_paise)],
                  ['GST', T.rupees(split.gst_paise)], ['Customer total', T.rupees(p.lifetime_paise)]],
          sections: [
            { heading: 'Payment', rows: [
              ['Plan', p.plan_name], ['Amount paid', T.rupees(p.amount_paise)], ['Paid at', T.ist(p.paid_at)],
              ['Channel', channel], ['Gateway', p.gateway || 'Razorpay'],
              ['Razorpay payment id', p.payment_id], ['Razorpay order id', p.order_id], ['GaadiPe payment no.', String(p.id)],
            ] },
            { heading: 'Where the money goes', rows: [
              ['Taxable value', T.rupees(split.taxable_paise)], ['GST @ 18%', T.rupees(split.gst_paise)],
              [`Razorpay fee (${split.fee_percent}%) + GST`, T.rupees(split.gateway_fee_paise + split.gateway_fee_gst_paise)],
              ['Take-home (before messaging)', T.rupees(split.take_home_paise)],
            ] },
            { heading: 'Vehicle', rows: veh ? [
              ['Registration', veh.reg_no], ['RTO', await rtoLine(veh.reg_no)],
              ['Make · model', [veh.maker, veh.model].filter(Boolean).join(' · ')],
              ['Fuel · class', [veh.fuel, veh.vehicle_class].filter(Boolean).join(' · ')],
            ] : [['Registration', 'Not recorded']] },
            { heading: 'Documents issued', rows: [
              ['Invoice', inv ? `${inv.invoice_number} · ${T.rupees(inv.total_paise)} (CGST ${T.rupees(inv.cgst_paise)} · SGST ${T.rupees(inv.sgst_paise)}${Number(inv.igst_paise) ? ` · IGST ${T.rupees(inv.igst_paise)}` : ''})` : 'Not issued yet — the reconciler will retry'],
              ['Place of supply', inv?.place_of_supply],
              ['Report', rep ? `${rep.report_number}${rep.valid_until ? ` · downloadable until ${T.ist(rep.valid_until)}` : ''}` : 'Not issued yet'],
              ['Monitoring', p.duration_days ? `${p.duration_days} days of document and challan alerts` : null],
            ] },
            { heading: 'Customer', rows: [
              ['Name', p.shown_name || 'Not given'], ['Mobile', T.mobile(p.mobile)], ['Email', p.email],
              ['Customer since', T.ist(p.customer_since)], ['Payments so far', String(p.paid_count)],
              ['Declaration', decl ? `C-${decl.id} · ${T.ist(decl.created_at)}${decl.detail?.declaration_language === 'hi' ? ' · accepted in Hindi' : ''}` : 'Not found'],
              ['From', decl?.detail?.ip ? `${decl.detail.ip}${decl.detail.user_agent ? ` · ${device.describe(device.parseUA(decl.detail.user_agent)) || ''}` : ''}` : null],
            ] },
          ],
          cta: { label: 'Open reports & invoices', path: '/documents' },
        }),
      };
    }) ? 1 : 0;
  }
  return n;
}

/* ───────────────────────────────────────────────────── contact / feedback ── */

/* Support tickets and contact messages also go to support_ticket_emails
   (user, 2026-09-29) — on top of the admin recipients, and only these emails:
   the sign-in, payment and summary emails stay with the admins alone. */
async function ticketRecipients() {
  const extra = String(await settings.get('support_ticket_emails', '') || '')
    .split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /@/.test(s));
  return [...new Set([...(await mailer.adminRecipients()), ...extra])];
}

async function contacts() {
  if (!(await on('notify_contact'))) return 0;
  const to = await ticketRecipients();
  const { rows } = await db.query(
    `SELECT * FROM contact_messages c WHERE c.created_at > now() - interval '2 days'
        AND ${notDone('contact', 'c.id::text')} ORDER BY c.id LIMIT 20`);
  let n = 0;
  for (const c of rows) {
    n += await deliver('contact', c.id, async () => ({
      to,
      subject: `✉️ Contact form · ${c.subject || 'New message'} · ${c.name}`,
      replyTo: c.email || undefined,
      ...T.layout({
        badge: { text: 'New message from the website', tone: 'watch' },
        title: c.subject || `Message from ${c.name}`,
        lead: `${c.name} wrote through the contact form ${T.ist(c.created_at)}.${c.email ? ' Reply to this email to answer them directly.' : ''}`,
        note: c.message,
        sections: [
          { heading: 'From', rows: [
            ['Name', c.name], ['Mobile', c.mobile ? T.mobile(c.mobile) : null], ['Email', c.email],
            ['Vehicle', c.reg_no], ['Signed-in customer', c.user_id ? `Yes · customer ${c.user_id}` : 'No'],
            ['Language', c.language === 'hi' ? 'Hindi' : 'English'],
          ] },
          { heading: 'Sent from', rows: [
            ['IP address', c.ip], ['Place (approximate)', device.placeOf(device.locate(c.ip))],
            ['Device', device.describe(device.parseUA(c.user_agent))], ['Message no.', String(c.id)],
          ] },
        ],
        cta: { label: 'Open messages', path: '/feedback' },
      }),
    })) ? 1 : 0;
  }
  return n;
}

async function feedback() {
  if (!(await on('notify_feedback'))) return 0;
  const { rows } = await db.query(
    `SELECT f.*, coalesce(u.display_name, u.wa_profile_name, f.name) AS shown_name FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
      WHERE f.created_at > now() - interval '2 days' AND ${notDone('feedback', 'f.id::text')}
      ORDER BY f.id LIMIT 20`);
  let n = 0;
  for (const f of rows) {
    n += await deliver('feedback', f.id, async () => ({
      subject: `💬 Feedback${f.rating ? ` ${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)}` : ''} · ${f.shown_name || (f.mobile ? T.mobile(f.mobile) : 'Anonymous customer')}${f.reg_no ? ` · ${f.reg_no}` : ''}`,
      ...T.layout({
        badge: { text: 'New feedback', tone: 'info' },
        title: `Feedback from ${f.shown_name || (f.mobile ? T.mobile(f.mobile) : 'an anonymous customer')}`,
        lead: `Sent ${T.ist(f.created_at)}${f.reg_no ? ` about ${f.reg_no}` : ''}.`,
        note: f.body,
        sections: [{ heading: 'From', rows: [['Rating', f.rating ? `${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)} (${f.rating}/5)` : null],
          ['Name', f.shown_name || 'Anonymous customer'], ['Mobile', f.mobile ? T.mobile(f.mobile) : 'Not given'], ['Vehicle', f.reg_no],
          ['Came from', f.channel && f.channel !== 'whatsapp' ? `Website${f.channel.includes(':') ? ` (${f.channel.split(':')[1]})` : ''}` : 'WhatsApp']] }],
        cta: { label: 'Open feedback', path: '/feedback' },
      }),
    })) ? 1 : 0;
  }
  return n;
}


/* ─────────────────────────────────────────────────────── WhatsApp chat ──
   GaadiPe lives on WhatsApp now (user, 2026-09-25), so the moments worth an
   email happen in the chat. The bot already writes each one to event_log as a
   funnel step (flow.js funnel()); these read those rows, so the chat is never
   slowed by mail. One email per event, guaranteed once by admin_notifications. */

/*
 * TEST MODE (user, 2026-09-25): while notify_wa_only_from lists numbers, the
 * WhatsApp emails are sent only for activity from those numbers, so testing
 * does not bury the inbox. Empty = every number. Same shape as
 * customer_email_only_to.
 */
async function onlyFrom() {
  return String(await settings.get('notify_wa_only_from', '') || '')
    .split(',').map((m) => m.replace(/\D/g, '').slice(-10)).filter((m) => m.length === 10);
}

/** The funnel events of one step from the last hour that have not been emailed. */
async function funnelEvents(step, kind) {
  const only = await onlyFrom();
  const { rows } = await db.query(
    `SELECT e.id, e.created_at, e.detail FROM event_log e
      WHERE e.kind = 'funnel' AND e.detail->>'step' = $1
        AND e.created_at > now() - interval '1 hour'
        AND (cardinality($2::text[]) = 0 OR e.detail->>'mobile' = ANY($2::text[]))
        AND ${notDone(kind, 'e.id::text')}
      ORDER BY e.id LIMIT 30`, [step, only]);
  return rows;
}

/** Who a mobile is, as far as GaadiPe knows — for the "Who" rows. */
async function whoIs(mobile) {
  return db.one(
    `SELECT s.profile_name, s.created_at AS first_seen,
            u.id AS user_id, u.display_name,
            (SELECT count(*)::int FROM user_vehicles uv WHERE uv.user_id = u.id) AS vehicles,
            (SELECT count(*)::int FROM payments p WHERE p.user_id = u.id
                AND p.status = 'paid' AND p.amount_paise > 0) AS paid
       FROM (SELECT $1::text AS mobile) m
       LEFT JOIN whatsapp_sessions s ON s.mobile = m.mobile
       LEFT JOIN users u ON u.mobile = m.mobile`, [mobile]);
}
const nameOf = (w, mobile) => w?.display_name || w?.profile_name || T.mobile(mobile);

/* "KA01 · Bengaluru Central, HSR Layout" — the plate's RTO and its office
   (user, 2026-10-01); just the code if the list has no name for it. */
async function rtoLine(reg) {
  const geo = require('../admin/geo');
  const code = geo.rtoCode(reg);
  if (!code) return null;
  const name = await geo.rtoNameOf(reg).catch(() => null);
  return name ? `${code} · ${name}` : code;
}

/*
 * MORE ABOUT A NEW CONTACT (user, 2026-09-30) — everything we know, without
 * guessing. WhatsApp shares no location, so "where" comes from what they did:
 * a website visit linked by the code in their Hi (city and state of the
 * connection), the state they chose at checkout, and the state codes of the
 * vehicles they checked. "How" is the Meta ad they tapped, the website source,
 * or neither. Each line says where it came from; a line with nothing is left out.
 */
async function hiDetails(mobile, userId, at) {
  const { STATES: REG } = require('../admin/geo');
  const { STATES: GST } = require('../pay/invoice');
  const [sess, visit, user, plates, first, today] = await Promise.all([
    db.one(`SELECT attribution FROM whatsapp_sessions WHERE mobile = $1`, [mobile]),
    db.one(`SELECT place, first_touch, device, page_views FROM visitors WHERE mobile = $1 ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [mobile]).catch(() => null),
    userId ? db.one(`SELECT state_code, email FROM users WHERE id = $1`, [userId]) : null,
    userId ? db.query(`SELECT v.reg_no, v.maker, v.model FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
                        WHERE uv.user_id = $1 ORDER BY uv.last_checked_at DESC NULLS LAST LIMIT 5`, [userId]) : { rows: [] },
    db.one(`SELECT body FROM whatsapp_messages WHERE mobile = $1 AND direction = 'in' ORDER BY id LIMIT 1`, [mobile]),
    db.one(`WITH b AS (SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AS d)
            SELECT (SELECT count(*) FROM whatsapp_sessions, b WHERE created_at >= b.d AND created_at <= $1)::int AS n,
                   (SELECT count(*) FROM whatsapp_sessions, b WHERE created_at >= b.d - interval '1 day'
                                                                AND created_at <= $1::timestamptz - interval '1 day')::int AS before`, [at]),
  ]);
  const a = sess?.attribution || {};
  const place = visit?.place || {};
  const ft = visit?.first_touch || a.first_touch || {};
  const dev = visit?.device || {};
  const plateStates = [...new Set(plates.rows.map((r) => REG[String(r.reg_no).slice(0, 2).toUpperCase()]).filter(Boolean))];

  const came = a.channel === 'whatsapp_ad'
    ? `Your WhatsApp ad${a.headline ? ` — “${a.headline}”` : ''}`
    : a.channel === 'website' || visit
      ? `Website${ft.source ? ` (from ${ft.source}${ft.campaign ? ` · ${ft.campaign}` : ''})` : ''}`
      : 'Straight to the WhatsApp number (saved it, or a forwarded link)';
  return {
    where: [
      ['City (from their internet)', place.country === 'India' && place.city ? `${place.city}, ${place.region || ''}`.replace(/, $/, '') : null],
      ['State (from their internet)', place.country === 'India' && !place.city ? place.region : null],
      ['State chosen at checkout', GST[String(user?.state_code || '')] || null],
      ['Vehicles registered in', plateStates.join(', ') || null],
      ['Where', !place.region && !user?.state_code && !plateStates.length ? 'Not known yet — WhatsApp does not share location' : null],
    ],
    how: [
      ['Came from', came],
      ['Ad link', a.channel === 'whatsapp_ad' ? a.source_url : null],
      ['First page on the website', ft.landing || null],
      ['Phone', [dev.device_type, dev.os, dev.browser].filter(Boolean).join(' · ') || null],
      ['Website pages seen', visit?.page_views ? String(visit.page_views) : null],
      ['First message', first?.body ? `“${String(first.body).slice(0, 120)}”` : null],
    ],
    recent: plates.rows.slice(0, 3).map((r) => [r.reg_no, [r.maker, r.model].filter(Boolean).join(' ') || '—']),
    today: today || { n: 0, before: 0 },
    email: user?.email || null,
  };
}

async function waHi() {
  if (!(await on('notify_wa_hi'))) return 0;
  let n = 0;
  for (const e of await funnelEvents('hi', 'wa_hi')) {
    const mobile = e.detail?.mobile;
    n += await deliver('wa_hi', e.id, async () => {
      const w = await whoIs(mobile);
      // New = their chat began within a minute of this Hi.
      const isNew = !w?.first_seen || Math.abs(new Date(e.created_at) - new Date(w.first_seen)) < 60 * 1000;
      const d = await hiDetails(mobile, w?.user_id, e.created_at).catch(() => null);
      const where = d?.where.find(([k, v]) => v && k !== 'Where')?.[1];
      return {
        subject: `👋 ${isNew ? 'New on WhatsApp' : 'Said Hi'} · ${nameOf(w, mobile)}${where ? ` · ${where}` : ''}`,
        ...T.layout({
          badge: { text: isNew ? 'New contact' : 'Said Hi again', tone: isNew ? 'good' : 'info' },
          title: `${nameOf(w, mobile)} said Hi on WhatsApp`,
          lead: `${T.ist(e.created_at)}. ${isNew ? 'First time they have written to GaadiPe.' : 'They have written before.'}`
            + (d && isNew ? ` New contact no. ${d.today.n} today (${d.today.before} by this time yesterday).` : ''),
          sections: [
            { heading: 'Who', rows: [
              ['WhatsApp name', w?.profile_name || 'Not shown'],
              ['Mobile', T.mobile(mobile)],
              ['Email', d?.email],
              ['Vehicles checked before', String(w?.vehicles ?? 0)],
              ['Paid before', w?.paid ? `Yes (${w.paid})` : 'No'],
            ] },
            ...(d ? [
              { heading: 'Where', rows: d.where },
              { heading: 'How they found GaadiPe', rows: d.how },
              ...(d.recent.length ? [{ heading: 'Vehicles they checked', rows: d.recent }] : []),
            ] : []),
          ],
          cta: { label: 'Open Live', path: '/live' },
        }),
      };
    }) ? 1 : 0;
  }
  return n;
}

async function waChecks() {
  if (!(await on('notify_wa_checks'))) return 0;
  let n = 0;
  for (const step of ['basic_shown', 'lookup_failed']) {
    for (const e of await funnelEvents(step, 'wa_check')) {
      const d = e.detail || {};
      const failed = step === 'lookup_failed';
      n += await deliver('wa_check', e.id, async () => {
        const w = await whoIs(d.mobile);
        const v = d.reg_no ? await db.one(
          `SELECT maker, model, fuel, vehicle_class FROM vehicles WHERE reg_no = $1`, [d.reg_no]) : null;
        const today = await db.one(
          `SELECT count(*)::int AS n FROM event_log
            WHERE kind = 'funnel' AND detail->>'step' = 'basic_shown' AND detail->>'mobile' = $1
              AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`,
          [d.mobile]);
        const outcome = failed
          ? (d.reason === 'not_found' ? 'Not found in Government records' : 'Lookup failed — records service error')
          : (d.bought ? 'Full report (already bought)' : 'Basic details shown');
        /*
         * NEW OR REPEAT (user, 2026-10-06: "append new / existing basic /
         * existing full"): has this customer checked this vehicle before?
         *   New vehicle                 first time for them
         *   Repeat check · basic        seen before, no full report
         *   Repeat check · full report  they already bought its full report
         */
        const before = d.reg_no ? await db.one(
          `SELECT count(*)::int AS n FROM event_log
            WHERE kind = 'funnel' AND detail->>'step' = 'basic_shown' AND detail->>'mobile' = $1
              AND upper(detail->>'reg_no') = upper($2) AND id <> $3 AND created_at <= $4`,
          [d.mobile, d.reg_no, e.id, e.created_at]) : null;
        const kindOf = d.bought ? 'Repeat check · full report'
          : before?.n ? 'Repeat check · basic' : 'New vehicle';
        return {
          subject: `${failed ? '⚠️' : '🔎'} ${d.reg_no || 'Vehicle'} checked · ${nameOf(w, d.mobile)} · ${kindOf}`,
          ...T.layout({
            badge: { text: failed ? `Check failed · ${kindOf}` : kindOf, tone: failed ? 'watch' : d.bought ? 'good' : 'info' },
            title: `${nameOf(w, d.mobile)} checked ${d.reg_no || 'a vehicle'}`,
            lead: `${T.ist(e.created_at)} · ${outcome}.`,
            sections: [
              { heading: 'Vehicle', rows: [
                ['Number', d.reg_no],
                ['RTO', d.reg_no ? await rtoLine(d.reg_no) : null],
                ['Make · model', v ? [v.maker, v.model].filter(Boolean).join(' · ') : '—'],
                ['Fuel · type', v ? [v.fuel, v.vehicle_class].filter(Boolean).join(' · ') : '—'],
                ['Result', outcome],
                ['Check', before?.n ? `${kindOf} — checked ${before.n} time${before.n === 1 ? '' : 's'} before` : kindOf],
              ] },
              { heading: 'Who', rows: [
                ['WhatsApp name', w?.profile_name || 'Not shown'],
                ['Mobile', T.mobile(d.mobile)],
                ['Checks today', String(today?.n ?? 0)],
                ['Paid before', w?.paid ? `Yes (${w.paid})` : 'No'],
              ] },
            ],
            cta: { label: 'Open vehicles', path: '/vehicles' },
          }),
        };
      }) ? 1 : 0;
    }
  }
  return n;
}

async function waOptOut() {
  if (!(await on('notify_wa_opt_out'))) return 0;
  let n = 0;
  for (const e of await funnelEvents('opt_out', 'wa_opt_out')) {
    const mobile = e.detail?.mobile;
    n += await deliver('wa_opt_out', e.id, async () => {
      const w = await whoIs(mobile);
      return {
        subject: `🛑 Replied STOP · ${nameOf(w, mobile)}`,
        ...T.layout({
          badge: { text: 'Replied STOP', tone: 'wrong' },
          title: `${nameOf(w, mobile)} replied STOP`,
          lead: `${T.ist(e.created_at)}. GaadiPe will not message them until they reply START; they are left out of every broadcast.`,
          sections: [{ heading: 'Who', rows: [
            ['WhatsApp name', w?.profile_name || 'Not shown'],
            ['Mobile', T.mobile(mobile)],
            ['Vehicles checked', String(w?.vehicles ?? 0)],
            ['Paid before', w?.paid ? `Yes (${w.paid})` : 'No'],
          ] }],
          cta: { label: 'Open Live', path: '/live' },
        }),
      };
    }) ? 1 : 0;
  }
  // Why they said STOP, when they answer the one question after it (user, 2026-10-02).
  for (const e of await funnelEvents('opt_out_reason', 'wa_opt_out_reason')) {
    const mobile = e.detail?.mobile;
    n += await deliver('wa_opt_out_reason', e.id, async () => {
      const w = await whoIs(mobile);
      return {
        subject: `🛑 Why STOP · ${nameOf(w, mobile)}: ${e.detail?.reason || '—'}`,
        ...T.layout({
          badge: { text: 'STOP reason', tone: 'wrong' },
          title: `${nameOf(w, mobile)}: ${e.detail?.reason || '—'}`,
          lead: `${T.ist(e.created_at)}. Their answer to "May we ask why?" after STOP.`,
          sections: [{ heading: 'What they said', rows: [
            ['Reason', e.detail?.reason || '—'],
            ...(e.detail?.said ? [['In their words', e.detail.said]] : []),
            ['Mobile', T.mobile(mobile)],
            ['Vehicles checked', String(w?.vehicles ?? 0)],
            ['Paid before', w?.paid ? `Yes (${w.paid})` : 'No'],
          ] }],
          cta: { label: 'Open Live', path: '/live' },
        }),
      };
    }) ? 1 : 0;
  }
  return n;
}

/* Opened the ₹19 payment link and did not pay within 30 minutes: the warmest
   lead there is. Sent once per payment link, and only while it is still unpaid. */
async function leftAtPayment() {
  if (!(await on('notify_left_at_payment'))) return 0;
  const only = await onlyFrom();
  const { rows } = await db.query(
    `SELECT e.id, e.created_at, e.detail, p.amount_paise
       FROM event_log e
       JOIN payments p ON p.id = (e.detail->>'payment_row')::bigint
      WHERE e.kind = 'funnel' AND e.detail->>'step' = 'link_sent'
        AND e.created_at < now() - interval '30 minutes'
        AND e.created_at > now() - interval '6 hours'
        AND p.status = 'created'
        AND (cardinality($1::text[]) = 0 OR e.detail->>'mobile' = ANY($1::text[]))
        AND ${notDone('left_at_pay', 'e.id::text')}
      ORDER BY e.id LIMIT 20`, [only]);
  let n = 0;
  for (const e of rows) {
    const d = e.detail || {};
    n += await deliver('left_at_pay', e.id, async () => {
      const w = await whoIs(d.mobile);
      return {
        subject: `⏳ Left at payment · ${d.reg_no || ''} · ${nameOf(w, d.mobile)}`,
        ...T.layout({
          badge: { text: 'Did not pay', tone: 'watch' },
          title: `${nameOf(w, d.mobile)} opened the payment link and did not pay`,
          lead: `Link sent ${T.ist(e.created_at)} for ${T.rupees(e.amount_paise)} — still unpaid after 30 minutes.`,
          sections: [{ heading: 'Details', rows: [
            ['Vehicle', d.reg_no],
            ['Amount', T.rupees(e.amount_paise)],
            ['WhatsApp name', w?.profile_name || 'Not shown'],
            ['Mobile', T.mobile(d.mobile)],
          ] }],
          note: 'They can still pay on the same link. A reply from you in the chat within 24 hours of their last message is free.',
          cta: { label: 'Open Live', path: '/live' },
        }),
      };
    }) ? 1 : 0;
  }
  return n;
}

/* ────────────────────────────────────────────────────────────── alerts ──
   A critical or warning alert from the alert center (phase 6), emailed once
   when it opens. Info and success alerts stay on the panel. */
async function alertMails() {
  if (!(await on('notify_alerts'))) return 0;
  const { rows } = await db.query(
    `SELECT a.* FROM admin_alerts a
      WHERE a.severity IN ('critical', 'warning') AND a.created_at > now() - interval '2 hours'
        AND coalesce(a.source, '') <> 'whatsapp'  -- WhatsApp is retired: its alerts are not mailed (2026-10-07)
        AND ${notDone('alert', 'a.id::text')}
      ORDER BY a.id LIMIT 20`);
  let n = 0;
  for (const a of rows) {
    n += await deliver('alert', a.id, async () => ({
      subject: `${a.severity === 'critical' ? '🔴' : '🟠'} ${a.title}`,
      ...T.layout({
        badge: { text: a.severity === 'critical' ? 'Critical' : 'Warning', tone: a.severity === 'critical' ? 'wrong' : 'watch' },
        title: a.title,
        lead: `${T.ist(a.created_at)} · ${String(a.source).replace(/_/g, ' ')}`,
        note: a.description,
        cta: { label: 'Open the alert center', path: '/alerts' },
        footer: 'You will not be emailed again while this alert stays open. Switch these off under Settings → Emails to you (notify_alerts).',
      }),
    })) ? 1 : 0;
  }
  return n;
}

/* ─────────────────────────────────────────────────────────── security ──
   Misbehaviour, batched (user, 2026-09-18): every event since the last security
   email, grouped by what happened and from where, at most one email per
   `security_alert_cooldown_minutes`. A flood becomes one email, not a thousand. */

const SECURITY_WORDS = {
  rate_limit: 'Too many requests from one address',
  blocked_ip: 'Address blocked for flooding',
  loop: 'The same request repeated in a loop',
  scraping: 'Scraping pattern — many different vehicles checked',
  bot: 'Automation tool on the site API (curl, Python, headless browser…)',
  plain_request: 'Tried to call the API without encryption',
  bad_envelope: 'Tampered or undecryptable request',
  replay: 'Replayed request (copied and sent again)',
  key_misuse: 'Encryption key used from another browser, tool or account',
  full_view_cap: 'Daily limit of full records reached by one account',
};

async function security() {
  if (!(await on('notify_security'))) return 0;
  const last = await db.one(
    `SELECT coalesce(max(ref::bigint), 0) AS upto, max(sent_at) AS at FROM admin_notifications
      WHERE kind = 'security' AND status = 'sent'`);
  const cooldown = await settings.num('security_alert_cooldown_minutes', 15);
  if (last.at && Date.now() - new Date(last.at).getTime() < cooldown * 60 * 1000) return 0;

  const { rows } = await db.query(
    `SELECT * FROM security_events WHERE id > $1 ORDER BY id LIMIT 500`, [last.upto]);
  if (!rows.length) return 0;
  const upto = rows[rows.length - 1].id;

  return (await deliver('security', upto, async () => {
    const groups = new Map();
    for (const e of rows) {
      const k = `${e.kind}|${e.ip || '?'}`;
      const g = groups.get(k) || { kind: e.kind, ip: e.ip, n: 0, first: e.created_at, last: e.created_at,
        severity: e.severity, surface: e.surface, mobile: e.mobile, path: e.path, ua: e.user_agent, detail: e.detail };
      g.n += 1; g.last = e.created_at;
      if (e.severity === 'high') g.severity = 'high';
      groups.set(k, g);
    }
    const list = [...groups.values()].sort((a, b) => (b.severity === 'high') - (a.severity === 'high') || b.n - a.n);
    const high = list.some((g) => g.severity === 'high');
    return {
      subject: `${high ? '🚨' : '⚠️'} Security · ${rows.length} event${rows.length === 1 ? '' : 's'} · ${list.map((g) => g.kind).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`,
      ...T.layout({
        badge: { text: high ? 'Needs a look' : 'For your information', tone: high ? 'wrong' : 'watch' },
        title: `${rows.length} suspicious request${rows.length === 1 ? '' : 's'} since the last alert`,
        lead: 'GaadiPe refused or slowed these down automatically. Nothing needs doing unless it keeps coming from the same place — then block that number or vehicle in the panel.',
        stats: [['Events', String(rows.length)], ['Addresses', String(new Set(rows.map((r) => r.ip)).size)],
                ['Serious', String(rows.filter((r) => r.severity === 'high').length)]],
        sections: list.slice(0, 12).map((g) => ({
          heading: `${SECURITY_WORDS[g.kind] || g.kind}${g.severity === 'high' ? ' — serious' : ''}`,
          rows: [
            ['Times', String(g.n)], ['From IP', g.ip], ['Place (approximate)', device.placeOf(device.locate(g.ip))],
            ['When', g.n > 1 ? `${T.ist(g.first)} → ${T.ist(g.last)}` : T.ist(g.last)],
            ['Where', `${g.surface || '—'} · ${g.path || '—'}`], ['Customer', g.mobile ? T.mobile(g.mobile) : null],
            ['Client', g.ua], ['Detail', g.detail ? JSON.stringify(g.detail).slice(0, 300) : null],
          ],
        })),
        cta: { label: 'Open the security log', path: '/security' },
        footer: `At most one security email every ${cooldown} minutes. Limits and this alert are under Settings → Security in the admin panel.`,
      }),
    };
  })) ? 1 : 0;
}

/* ──────────────────────────────────────────────────────── daily summary ── */

/*
 * THE WEEKLY MONEY REPORT (user, 2026-10-01): every Saturday from 9 am IST,
 * the Excel of the week just ended (Saturday to Friday) to finance_report_emails
 * — gross, GST, Razorpay, WhatsApp by category, vehicle API, SMS, fleets, net.
 * Once per week, whatever the number of servers or ticks (admin_notifications).
 */
async function weeklyMoney({ force = false } = {}) {
  if (!force && !(await on('finance_weekly_email'))) return 0;
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  const dayWanted = await settings.num('finance_weekly_day', 6);       // 6 = Saturday
  const hour = await settings.num('finance_weekly_hour_ist', 9);
  if (!force && (now.getUTCDay() !== dayWanted || now.getUTCHours() < hour)) return 0;
  const weekly = require('../finance/weekly');
  const { from } = weekly.lastWeek();
  const to = String(await settings.get('finance_report_emails', '')).split(/[,\s]+/).filter((x) => /@/.test(x));
  const send = async () => {
    const r = await weekly.build();
    const c = r.cur; const p = r.prev;
    const ch = (a, b) => (b ? ` (${a >= b ? '▲' : '▼'} ${Math.abs(Math.round(((a - b) / Math.abs(b)) * 100))}% vs last week)` : '');
    return {
      ...(to.length ? { to } : {}),
      subject: `📊 GaadiPe weekly money · ${r.label} · net ${T.rupees(c.net)}`,
      attachments: [{ filename: r.filename, content: r.xlsx,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
      ...T.layout({
        badge: { text: 'Weekly money report', tone: c.net >= 0 ? 'good' : 'watch' },
        title: `Week of ${r.label}`,
        lead: `${c.payments} report${c.payments === 1 ? '' : 's'} paid${c.fleet_payments ? ` and ${c.fleet_payments} fleet payment${c.fleet_payments === 1 ? '' : 's'}` : ''}. The full detail — by day, by payment and by WhatsApp template — is in the attached Excel.`,
        sections: [
          { heading: 'Money in', rows: [
            ['Gross received (incl. GST)', `${T.rupees(c.gross)}${ch(c.gross, p.gross)}`],
            ['GST collected', `${T.rupees(c.gst)} (CGST ${T.rupees(c.cgst)} · SGST ${T.rupees(c.sgst)}${c.igst ? ` · IGST ${T.rupees(c.igst)}` : ''})`],
            ['Net sales (excl. GST)', T.rupees(c.net_sales)],
            ['Refunds', c.refunds ? T.rupees(c.refunds) : null],
          ] },
          { heading: 'Costs', rows: [
            [`Razorpay fee + GST`, T.rupees(c.rzp_fee + c.rzp_gst)],
            [`WhatsApp utility · ${c.wa_utility.n} × ₹${(r.rates.wa_utility_paise / 100).toFixed(2)}`, T.rupees(c.wa_utility.cost)],
            [`WhatsApp marketing · ${c.wa_marketing.n} × ₹${(r.rates.wa_marketing_paise / 100).toFixed(2)}`, T.rupees(c.wa_marketing.cost)],
            ['Vehicle records API', `${T.rupees(c.api_cost)} · ${c.api_calls} calls`],
            ['SMS sign-in codes', c.sms ? T.rupees(c.sms_cost) : null],
            ['Total costs', T.rupees(c.costs)],
          ] },
          { heading: 'Result', rows: [
            ['Net profit', `${T.rupees(c.net)}${ch(c.net, p.net)}`],
            ['Margin on net sales', c.margin != null ? `${c.margin}%` : '—'],
            ['Meta ads spend', c.ads ? T.rupees(c.ads) : 'Not entered — Ad spend page'],
            ['Net profit after ads', c.ads ? T.rupees(c.net_after_ads) : null],
            ['Ads cost per paying customer', c.ads_per_paying ? T.rupees(c.ads_per_paying) : null],
          ] },
        ],
        note: 'GST collected is owed to the Government; ask your CA about input credit on Razorpay’s GST.',
        cta: { label: 'Open Profitability', path: '/profitability' },
      }),
    };
  };
  if (force) { const mail = await send(); return (await mailer.send(mail)).ok ? 1 : 0; }
  return (await deliver('finance_weekly', from.toISOString().slice(0, 10), send)) ? 1 : 0;
}

/*
 * THE DAY ON YOUR OWN WHATSAPP (user, 2026-10-01): at admin_whatsapp_summary_hour_ist
 * (11:55 pm), a short summary to each number in admin_whatsapp_numbers. WhatsApp
 * only allows a free message inside the 24-hour window, so it goes when that
 * number has written to the bot in the last day — say "hi" once a day to keep
 * it coming; otherwise it is skipped (the email summary still arrives).
 */
async function whatsappSummary() {
  const numbers = String(await settings.get('admin_whatsapp_numbers', ''))
    .split(/[,\s;]+/).map((x) => x.replace(/\D/g, '').slice(-10)).filter((x) => x.length === 10);
  if (!numbers.length) return 0;
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  if (!await reached('admin_whatsapp_summary_hour_ist', '23:55')) return 0;
  const today = now.toISOString().slice(0, 10);
  const claim = await db.one(
    `INSERT INTO event_log (kind, detail) SELECT 'admin_wa_summary', $1::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM event_log WHERE kind = 'admin_wa_summary' AND detail->>'day' = $2) RETURNING id`,
    [JSON.stringify({ day: today }), today]);
  if (!claim) return 0;
  const send = require('../whatsapp/send');
  const d = await db.one(
    `WITH b AS (SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AS t)
     SELECT (SELECT count(*) FROM users u, b WHERE u.created_at >= b.t AND NOT u.is_internal)::int AS joined,
            (SELECT count(DISTINCT mobile) FROM whatsapp_messages, b WHERE direction = 'in' AND created_at >= b.t)::int AS chatted,
            (SELECT count(*) FROM events, b WHERE name = 'vehicle_search_success' AND occurred_at >= b.t)::int AS checks,
            (SELECT count(*) FROM events, b WHERE name = 'vehicle_search_failed' AND occurred_at >= b.t)::int AS failed,
            (SELECT count(*) FROM payments, b WHERE status = 'paid' AND amount_paise > 0 AND paid_at >= b.t)::int AS paid,
            (SELECT coalesce(sum(amount_paise), 0) FROM payments, b WHERE status = 'paid' AND paid_at >= b.t)::int AS revenue,
            (SELECT count(*) FROM event_log, b WHERE kind = 'funnel' AND detail->>'step' = 'opt_out' AND created_at >= b.t)::int AS stops,
            (SELECT count(*) FROM lookup_waitlist WHERE status = 'waiting')::int AS waiting`);
  const text = `📊 *GaadiPe today* · ${today}\n\n`
    + `👋 New customers: *${d.joined}*\n💬 Chatted: *${d.chatted}*\n🔍 Checks: *${d.checks}*${d.failed ? ` (${d.failed} failed)` : ''}\n`
    + `💳 Paid: *${d.paid}* · *${T.rupees(d.revenue)}*\n`
    + (d.stops ? `🛑 STOP: ${d.stops}\n` : '')
    + (d.waiting ? `⏳ Waiting for vehicle records: ${d.waiting}\n` : '')
    + '\n_Reply "hi" any time to keep this daily summary coming._';
  let sent = 0;
  for (const m of numbers) {
    if (!(await send.windowOpen(m))) { console.log('[notify] WhatsApp summary to …%s skipped: no message from that number in 24 hours', m.slice(-4)); continue; }
    const out = await send.text(m, text);
    if (out?.ok) sent += 1;
  }
  await db.query(`UPDATE event_log SET detail = detail || $2::jsonb WHERE id = $1`, [claim.id, JSON.stringify({ sent })]);
  return sent;
}

async function dailySummary() {
  if (!(await on('daily_summary_email'))) return 0;
  if (!await reached('daily_summary_hour_ist', '23:55')) return 0;
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  const today = now.toISOString().slice(0, 10);

  return (await deliver('daily_summary', today, async () => {
    const { compare } = require('../admin/insights');
    const c = (await compare()).day;
    const d = c.current; const y = c.previous_full;
    // WhatsApp-first (user, 2026-09-25): the chat's day, not the website's.
    const extra = await db.one(
      `SELECT (SELECT count(*) FROM whatsapp_messages WHERE direction = 'in'
                 AND created_at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS wa_in,
              (SELECT count(DISTINCT mobile) FROM whatsapp_messages WHERE direction = 'in'
                 AND created_at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS wa_people,
              (SELECT count(*) FROM event_log WHERE kind = 'funnel' AND detail->>'step' = 'opt_out'
                 AND created_at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS stops,
              (SELECT count(*) FROM event_log WHERE kind = 'watch_digest' AND detail->>'ist_date' = $1)::int AS alerts,
              (SELECT count(*) FROM contact_messages WHERE created_at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS contacts,
              (SELECT count(*) FROM whatsapp_sessions WHERE last_inbound_at > now() - interval '15 minutes')::int AS online`, [today]);
    const { rows: paid } = await db.query(
      `SELECT p.amount_paise, p.paid_at, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
              (SELECT reg_no FROM vehicle_reports r WHERE r.payment_id = p.id LIMIT 1) AS reg_no
         FROM payments p JOIN users u ON u.id = p.user_id
        WHERE p.status = 'paid' AND p.paid_at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
        ORDER BY p.paid_at`);
    const vs = (a, b, money) => `${money ? T.rupees(a) : a}  (yesterday ${money ? T.rupees(b) : b})`;
    return {
      subject: `📊 GaadiPe today · ${T.rupees(d.gross_paise)} · ${d.payments} payment${d.payments === 1 ? '' : 's'} · ${d.checks} checks`,
      ...T.layout({
        badge: { text: 'Daily summary', tone: 'info' },
        title: `Your day at GaadiPe — ${today}`,
        lead: d.payments
          ? `${d.payments} payment${d.payments === 1 ? '' : 's'} today, ${T.rupees(d.take_home_paise)} take-home after GST, fees and messaging.`
          : 'No payments today yet. Here is how the day went.',
        stats: [['Revenue', T.rupees(d.gross_paise)], ['Take-home', T.rupees(d.take_home_paise)],
                ['Payments', String(d.payments)], ['Checks', String(d.checks)]],
        sections: [
          { heading: 'Today against yesterday', rows: [
            ['Revenue', vs(d.gross_paise, y.gross_paise, true)], ['Take-home', vs(d.take_home_paise, y.take_home_paise, true)],
            ['Payments', vs(d.payments, y.payments)], ['Vehicle checks', vs(d.checks, y.checks)],
            ['People checking', vs(d.active_users, y.active_users)], ['New customers', vs(d.new_users, y.new_users)],
            ['New vehicles', vs(d.new_vehicles, y.new_vehicles)],
            ['Conversion', `${d.conversion}%  (yesterday ${y.conversion}%)`],
            ['Abandoned payments', vs(d.abandoned, y.abandoned)],
          ] },
          { heading: 'Also today', rows: [
            ['Reports issued', String(d.reports)], ['Evening alerts sent', String(extra.alerts)],
            ['WhatsApp messages received', `${extra.wa_in} from ${extra.wa_people} people`],
            ['Replied STOP', String(extra.stops)], ['Contact messages', String(extra.contacts)],
            ['Feedback', String(d.feedback)], ['Chatting right now', String(extra.online)],
            ['Messaging cost', T.rupees(d.messaging_paise)],
          ] },
          paid.length ? { heading: 'Payments today', rows: paid.map((r) => [
            `${T.ist(r.paid_at).split(', ')[1]}`, `${T.rupees(r.amount_paise)} · ${r.name || T.mobile(r.mobile)}${r.reg_no ? ` · ${r.reg_no}` : ''}`,
          ]) } : null,
        ],
        cta: { label: 'Open analytics', path: '/analytics' },
        footer: `Sent once a day from ${hour}:00 IST. Switch it off under Settings → Emails in the admin panel.`,
      }),
    };
  })) ? 1 : 0;
}

/* ──────────────────────────────────────────────────────────────── loop ── */

async function runOnce() {
  if (!mailer.configured()) return { skipped: 'mail not configured' };
  const out = {};
  /* NO EMAIL FROM WHATSAPP ACTIVITY (user, 2026-10-07: "stop all mails triggering
     from WhatsApp"). WhatsApp is retired: "said hi", WhatsApp checks, STOP and its
     reason, left at the WhatsApp payment link and the WhatsApp summary no longer
     run; payments and alerts below mail only the website's. */
  for (const [k, fn] of Object.entries({ visits, signIns, webChecks, chatChecks, pushOn, payments, contacts, feedback,
                                            alertMails, security, dailySummary, weeklyMoney, weeklyDigest })) {
    try { out[k] = await fn(); } catch (e) { console.error('[notify] %s: %s', k, e.message); }
  }
  const total = Object.values(out).reduce((t, v) => t + (Number(v) || 0), 0);
  if (total) console.log('[notify] emailed the admin: %j', out);
  return out;
}

/*
 * MONDAY: WHAT CHANGED (user, 2026-10-03). From 9 am IST on Mondays, once:
 * last week (Mon–Sun) against the week before — customers, checks, paid
 * reports, revenue, conversion, margin, STOP rate and the top STOP reason —
 * with one line on what moved most. To the admin's WhatsApp (in its window),
 * email when configured, and the phone.
 */
async function weeklyDigest() {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  if (now.getUTCDay() !== 1 || now.getUTCHours() < await settings.num('weekly_digest_hour_ist', 9)) return 0;
  const week = now.toISOString().slice(0, 10);
  const claim = await db.one(
    `INSERT INTO event_log (kind, detail) SELECT 'admin_weekly_digest', $1::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM event_log WHERE kind = 'admin_weekly_digest' AND detail->>'week' = $2) RETURNING id`,
    [JSON.stringify({ week }), week]);
  if (!claim) return 0;
  const R = await require('../finance/ledger').rates();
  const span = async (fromDays, toDays) => db.one(
    `WITH b AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - ($1 || ' days')::interval) AT TIME ZONE 'Asia/Kolkata' AS a,
                       (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - ($2 || ' days')::interval) AT TIME ZONE 'Asia/Kolkata' AS z)
     SELECT (SELECT count(*) FROM users, b WHERE created_at >= b.a AND created_at < b.z)::int AS customers,
            (SELECT count(*) FROM event_log, b WHERE kind IN ('vehicle_check', 'vehicle_check_repeat') AND created_at >= b.a AND created_at < b.z)::int AS checks,
            (SELECT count(*) FROM vehicle_reports r JOIN payments p ON p.id = r.payment_id, b
              WHERE p.status = 'paid' AND p.amount_paise > 0 AND r.created_at >= b.a AND r.created_at < b.z)::int AS reports,
            (SELECT coalesce(sum(amount_paise), 0) FROM payments, b WHERE status = 'paid' AND amount_paise > 0 AND paid_at >= b.a AND paid_at < b.z)::bigint AS revenue,
            (SELECT count(DISTINCT detail->>'mobile') FROM event_log, b WHERE kind = 'funnel' AND detail->>'step' = 'hi' AND created_at >= b.a AND created_at < b.z)::int AS hi,
            (SELECT count(DISTINCT user_id) FROM payments, b WHERE status = 'paid' AND amount_paise > 0 AND paid_at >= b.a AND paid_at < b.z)::int AS payers,
            (SELECT count(*) FROM event_log, b WHERE kind = 'funnel' AND detail->>'step' = 'opt_out' AND created_at >= b.a AND created_at < b.z)::int AS stops,
            (SELECT coalesce(sum(cost_paise), 0) FROM api_calls, b WHERE created_at >= b.a AND created_at < b.z)::bigint AS api,
            (SELECT ${require('../finance/ledger').waCostSql('m', R)} FROM whatsapp_messages m, b
              WHERE m.direction = 'out' AND m.message_type = 'template' AND m.created_at >= b.a AND m.created_at < b.z)::bigint AS wa,
            (SELECT coalesce(sum(amount_paise), 0) FROM ad_spend, b WHERE product = 'gaadipe' AND day >= (b.a AT TIME ZONE 'Asia/Kolkata')::date AND day < (b.z AT TIME ZONE 'Asia/Kolkata')::date)::bigint AS ads,
            (SELECT e.detail->>'reason' FROM event_log e, b WHERE e.kind = 'funnel' AND e.detail->>'step' = 'opt_out_reason' AND e.created_at >= b.a AND e.created_at < b.z
              GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) AS top_reason`, [String(fromDays), String(toDays)]);
  // Today is Monday: last week is 7..0 days back; the week before 14..7.
  const [a, b] = await Promise.all([span(7, 0), span(14, 7)]);
  const g = Number(R.gst_percent || 18) / 100; const fee = (Number(R.fee_percent || 2) / 100) * (1 + Number(R.fee_gst_percent || 18) / 100);
  const derive = (x) => {
    const rev = Number(x.revenue);
    const left = rev - (rev - rev / (1 + g)) - rev * fee - Number(x.api) - Number(x.wa) - Number(x.ads);
    return { ...x, revenue: rev, conv: x.hi ? (x.payers / x.hi) * 100 : null, margin: rev ? (left / rev) * 100 : null, stop_rate: x.customers ? (x.stops / x.customers) * 100 : null };
  };
  const A = derive(a); const B = derive(b);
  const pctChange = (n, o) => (o ? Math.round(((n - o) / o) * 100) : null);
  const line = (icon, label, n, o, fmt = (v) => String(v)) => {
    const c = pctChange(Number(n || 0), Number(o || 0));
    return `${icon} ${label}: *${fmt(n)}* ${c == null ? '' : c === 0 ? '(same)' : `(${c > 0 ? '▲' : '▼'} ${Math.abs(c)}%)`}`;
  };
  const pts = (v) => (v == null ? '—' : `${Math.round(v * 10) / 10}%`);
  const movers = [['New customers', A.customers, B.customers], ['Vehicle checks', A.checks, B.checks],
    ['Full reports', A.reports, B.reports], ['Revenue', A.revenue, B.revenue]]
    .map(([l, n, o]) => [l, pctChange(n, o)]).filter(([, c]) => c != null).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  const text = [
    line('👋', 'New customers', A.customers, B.customers),
    line('🔍', 'Vehicle checks', A.checks, B.checks),
    line('📋', 'Full reports', A.reports, B.reports),
    line('💰', 'Revenue', A.revenue, B.revenue, (v) => T.rupees(v)),
    `🎯 Conversion (hi → paid): *${pts(A.conv)}* (was ${pts(B.conv)})`,
    `📊 Margin after costs and ads: *${pts(A.margin)}* (was ${pts(B.margin)})`,
    `🛑 STOP rate: *${pts(A.stop_rate)}* (was ${pts(B.stop_rate)})${A.top_reason ? ` · top reason: ${A.top_reason}` : ''}`,
    '',
    movers.length ? `Biggest change: *${movers[0][0]}* ${movers[0][1] > 0 ? 'up' : 'down'} ${Math.abs(movers[0][1])}% on the week before.` : 'Not enough data from the week before to compare.',
  ].join('\n');
  await require('../util/adminPing').ping({ key: 'weekly_digest', alert: false, severity: 'info', source: 'reports', title: `📈 GaadiPe last week · ${week}`, text });
  await db.query(`UPDATE event_log SET detail = detail || $2::jsonb WHERE id = $1`, [claim.id, JSON.stringify({ sent: true })]);
  return 1;
}

function start(everySeconds = 30) {
  if (!mailer.configured()) {
    /*
     * EMAIL OFF, WHATSAPP STILL ON (2026-10-03). The admin's WhatsApp summary,
     * the Monday digest and the phone notifications do not need email, and
     * used to stop with it.
     */
    console.log('  admin email: off (MAIL_HOST / NOREPLYMAIL / NOREPLYMAIL_PASSWORD not set) — WhatsApp summaries still on');
    let busy = false;
    const lite = async () => {
      if (busy) return;
      busy = true;
      try {
        await whatsappSummary().catch((e) => console.error('[notify] whatsapp summary:', e.message));
        await weeklyDigest().catch((e) => console.error('[notify] weekly digest:', e.message));
        await require('../util/push').feed().catch(() => {});
      } finally { busy = false; }
    };
    setInterval(lite, everySeconds * 1000).unref();
    setTimeout(lite, 8000).unref();
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runOnce(); await require('../util/push').feed().catch(() => {}); } catch (e) { console.error('[notify] pass failed:', e.message); } finally { running = false; }
  };
  // Heartbeat: System health and the alert checker see when this last ran.
  setInterval(require('../util/heartbeat').wrap('notify', tick, everySeconds), everySeconds * 1000).unref();
  setTimeout(tick, 5000).unref();
  console.log(`  admin email: every ${everySeconds}s from ${process.env.NOREPLYMAIL}`);
}

module.exports = { start, runOnce, visits, signIns, webChecks, chatChecks, pushOn, payments, contacts, feedback, waHi, waChecks, waOptOut,
                   leftAtPayment, security, dailySummary, weeklyMoney, whatsappSummary, weeklyDigest };
