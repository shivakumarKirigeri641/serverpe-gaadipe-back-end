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
 *   daily_summary  the day's figures, once, from 9 pm IST
 *
 * WHY A JOB AND NOT A CALL IN EACH FLOW: a payment is confirmed in four places
 * (checkout, webhook, reconciler, WhatsApp), and a mail server that is slow or
 * down must never hold up any of them. Here the flows only write rows, as they
 * already do; this reads them, and a failed send is simply tried again on a
 * later tick (up to five times). admin_notifications is what guarantees once.
 *
 * Each kind can be switched off in Settings (notify_sign_ins, notify_payments,
 * notify_contact, notify_feedback, daily_summary_email).
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
  for (const [k, fn] of Object.entries({ signIns, payments, contacts, feedback, dailySummary })) {
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

module.exports = { start, runOnce, signIns, payments, contacts, feedback, dailySummary };
