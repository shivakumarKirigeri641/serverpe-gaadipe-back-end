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
 *   daily_summary  the day's figures, once, from 9 pm IST
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
        subject: `✅ Payment received · ${T.rupees(p.amount_paise)} · ${veh?.reg_no || p.plan_name || 'GaadiPe'} · ${who}`,
        attachments,
        ...T.layout({
          badge: { text: 'Payment successful', tone: 'good' },
          title: `${T.rupees(p.amount_paise)} received from ${who}`,
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
              ['Registration', veh.reg_no], ['Make · model', [veh.maker, veh.model].filter(Boolean).join(' · ')],
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

async function contacts() {
  if (!(await on('notify_contact'))) return 0;
  const { rows } = await db.query(
    `SELECT * FROM contact_messages c WHERE c.created_at > now() - interval '2 days'
        AND ${notDone('contact', 'c.id::text')} ORDER BY c.id LIMIT 20`);
  let n = 0;
  for (const c of rows) {
    n += await deliver('contact', c.id, async () => ({
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
    `SELECT f.*, coalesce(u.display_name, u.wa_profile_name) AS shown_name FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
      WHERE f.created_at > now() - interval '2 days' AND ${notDone('feedback', 'f.id::text')}
      ORDER BY f.id LIMIT 20`);
  let n = 0;
  for (const f of rows) {
    n += await deliver('feedback', f.id, async () => ({
      subject: `💬 Feedback · ${f.shown_name || T.mobile(f.mobile)}${f.reg_no ? ` · ${f.reg_no}` : ''}`,
      ...T.layout({
        badge: { text: 'New feedback', tone: 'info' },
        title: `Feedback from ${f.shown_name || T.mobile(f.mobile)}`,
        lead: `Sent ${T.ist(f.created_at)}${f.reg_no ? ` about ${f.reg_no}` : ''}.`,
        note: f.body,
        sections: [{ heading: 'From', rows: [['Name', f.shown_name || 'Not given'], ['Mobile', T.mobile(f.mobile)], ['Vehicle', f.reg_no]] }],
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

/** The funnel events of one step from the last hour that have not been emailed. */
async function funnelEvents(step, kind) {
  const { rows } = await db.query(
    `SELECT e.id, e.created_at, e.detail FROM event_log e
      WHERE e.kind = 'funnel' AND e.detail->>'step' = $1
        AND e.created_at > now() - interval '1 hour'
        AND ${notDone(kind, 'e.id::text')}
      ORDER BY e.id LIMIT 30`, [step]);
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

async function waHi() {
  if (!(await on('notify_wa_hi'))) return 0;
  let n = 0;
  for (const e of await funnelEvents('hi', 'wa_hi')) {
    const mobile = e.detail?.mobile;
    n += await deliver('wa_hi', e.id, async () => {
      const w = await whoIs(mobile);
      // New = their chat began within a minute of this Hi.
      const isNew = !w?.first_seen || Math.abs(new Date(e.created_at) - new Date(w.first_seen)) < 60 * 1000;
      return {
        subject: `👋 ${isNew ? 'New on WhatsApp' : 'Said Hi'} · ${nameOf(w, mobile)}`,
        ...T.layout({
          badge: { text: isNew ? 'New contact' : 'Said Hi again', tone: isNew ? 'good' : 'info' },
          title: `${nameOf(w, mobile)} said Hi on WhatsApp`,
          lead: `${T.ist(e.created_at)}. ${isNew ? 'First time they have written to GaadiPe.' : 'They have written before.'}`,
          sections: [{ heading: 'Who', rows: [
            ['WhatsApp name', w?.profile_name || 'Not shown'],
            ['Mobile', T.mobile(mobile)],
            ['Vehicles checked before', String(w?.vehicles ?? 0)],
            ['Paid before', w?.paid ? `Yes (${w.paid})` : 'No'],
          ] }],
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
        return {
          subject: `${failed ? '⚠️' : '🔎'} ${d.reg_no || 'Vehicle'} checked · ${nameOf(w, d.mobile)}`,
          ...T.layout({
            badge: { text: failed ? 'Check failed' : 'Vehicle checked', tone: failed ? 'watch' : 'info' },
            title: `${nameOf(w, d.mobile)} checked ${d.reg_no || 'a vehicle'}`,
            lead: `${T.ist(e.created_at)} · ${outcome}.`,
            sections: [
              { heading: 'Vehicle', rows: [
                ['Number', d.reg_no],
                ['Make · model', v ? [v.maker, v.model].filter(Boolean).join(' · ') : '—'],
                ['Fuel · type', v ? [v.fuel, v.vehicle_class].filter(Boolean).join(' · ') : '—'],
                ['Result', outcome],
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
  return n;
}

/* Opened the ₹19 payment link and did not pay within 30 minutes: the warmest
   lead there is. Sent once per payment link, and only while it is still unpaid. */
async function leftAtPayment() {
  if (!(await on('notify_left_at_payment'))) return 0;
  const { rows } = await db.query(
    `SELECT e.id, e.created_at, e.detail, p.amount_paise
       FROM event_log e
       JOIN payments p ON p.id = (e.detail->>'payment_row')::bigint
      WHERE e.kind = 'funnel' AND e.detail->>'step' = 'link_sent'
        AND e.created_at < now() - interval '30 minutes'
        AND e.created_at > now() - interval '6 hours'
        AND p.status = 'created'
        AND ${notDone('left_at_pay', 'e.id::text')}
      ORDER BY e.id LIMIT 20`);
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

async function dailySummary() {
  if (!(await on('daily_summary_email'))) return 0;
  const hour = await settings.num('daily_summary_hour_ist', 21);
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  if (now.getUTCHours() < hour) return 0;
  const today = now.toISOString().slice(0, 10);

  return (await deliver('daily_summary', today, async () => {
    const { compare } = require('../admin/insights');
    const c = (await compare()).day;
    const d = c.current; const y = c.previous_full;
    const extra = await db.one(
      `SELECT (SELECT count(*) FROM site_sign_ins WHERE event IN ('sign_in_failed','code_refused')
                 AND created_at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS failed,
              (SELECT count(*) FROM event_log WHERE kind = 'watch_digest' AND detail->>'ist_date' = $1)::int AS alerts,
              (SELECT count(*) FROM contact_messages WHERE created_at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS contacts,
              (SELECT count(*) FROM site_sessions WHERE ended_at IS NULL AND last_used_at > now() - interval '15 minutes')::int AS online`, [today]);
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
            ['New vehicles', vs(d.new_vehicles, y.new_vehicles)], ['Sign-ins', vs(d.sign_ins, y.sign_ins)],
            ['Conversion', `${d.conversion}%  (yesterday ${y.conversion}%)`],
            ['Abandoned payments', vs(d.abandoned, y.abandoned)],
          ] },
          { heading: 'Also today', rows: [
            ['Reports issued', String(d.reports)], ['Evening alerts sent', String(extra.alerts)],
            ['Failed or refused sign-ins', String(extra.failed)], ['Contact messages', String(extra.contacts)],
            ['Feedback', String(d.feedback)], ['Online right now', String(extra.online)],
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
  for (const [k, fn] of Object.entries({ signIns, payments, contacts, feedback, waHi, waChecks, waOptOut,
                                            leftAtPayment, security, dailySummary })) {
    try { out[k] = await fn(); } catch (e) { console.error('[notify] %s: %s', k, e.message); }
  }
  const total = Object.values(out).reduce((t, v) => t + (Number(v) || 0), 0);
  if (total) console.log('[notify] emailed the admin: %j', out);
  return out;
}

function start(everySeconds = 30) {
  if (!mailer.configured()) {
    console.log('  admin email: off (MAIL_HOST / NOREPLYMAIL / NOREPLYMAIL_PASSWORD not set)');
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runOnce(); } catch (e) { console.error('[notify] pass failed:', e.message); } finally { running = false; }
  };
  setInterval(tick, everySeconds * 1000).unref();
  setTimeout(tick, 5000).unref();
  console.log(`  admin email: every ${everySeconds}s from ${process.env.NOREPLYMAIL}`);
}

module.exports = { start, runOnce, signIns, payments, contacts, feedback, waHi, waChecks, waOptOut,
                   leftAtPayment, security, dailySummary };
