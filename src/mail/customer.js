/**
 * src/mail/customer.js — email to customers (user, 2026-09-21).
 *
 * Until GaadiPe has a WhatsApp Business number, email is how a customer hears
 * about their vehicles:
 *
 *   confirm   one click to confirm the address — nothing else is sent to an
 *             address until its owner has confirmed it, so a typo never mails
 *             somebody else's vehicle record to a stranger
 *   daily     a paying customer, every evening: the FULL record of each vehicle
 *             they paid for, and what changed since the last email
 *   digest    a signed-in customer who has not paid, every few days: the BASIC
 *             view of the vehicles they checked — the same as the free check
 *   purchase  the thank-you, the moment a payment is confirmed, carrying the
 *             report and the GST invoice as attachments — with no WhatsApp
 *             number this is the only thing a paying customer receives
 *
 * THE SAME RULE AS THE SITE. Both emails are built from site/vehicleView — full()
 * for a paid vehicle, basic() otherwise — from the record already stored, so an
 * email can never show more than the website would, and costs no lookup.
 *
 * TEST MODE. While the customer_email_only_to setting holds addresses, customer
 * email goes to those addresses ONLY; any other is recorded as skipped.
 */

const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');
const mailer = require('./mailer');
const T = require('./templates');
const view = require('../site/vehicleView');
const report = require('../whatsapp/report');

const esc = T.esc;
const SITE = () => (process.env.PUBLIC_SITE_URL || 'https://gaadipe.in').replace(/\/+$/, '');
const API = () => (process.env.PUBLIC_BASE_URL || 'https://api.gaadipe.in').replace(/\/+$/, '');
/** Where a customer's reply should land: a mailbox a person reads. */
const SUPPORT = process.env.SUPPORT_EMAIL || 'support@gaadipe.in';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 21 Sep 2026, in India's date. */
const istDay = (v) => {
  if (!v) return '—';
  const d = new Date(new Date(v).getTime() + 5.5 * 3600 * 1000);
  return Number.isNaN(d.getTime()) ? String(v) : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const rupees = (paise) => `₹${Math.round(Number(paise || 0) / 100).toLocaleString('en-IN')}`;

const validEmail = (e) => EMAIL_RE.test(String(e || '').trim());

/**
 * Save a customer's address. A NEW address starts unconfirmed with a fresh
 * token, and a confirmation email is queued; the same address again changes
 * nothing. Returns { changed }.
 */
async function setEmail(userId, email) {
  const clean = String(email || '').trim().toLowerCase().slice(0, 160);
  if (!validEmail(clean)) return { changed: false, error: 'bad_email' };
  const cur = await db.one(`SELECT email, email_verified_at FROM users WHERE id = $1`, [userId]);
  if (cur && String(cur.email || '').toLowerCase() === clean) return { changed: false };
  const token = crypto.randomBytes(24).toString('hex');
  await db.query(
    `UPDATE users SET email = $2, email_verified_at = NULL, email_unsubscribed_at = NULL,
            email_token = $3, modified_at = now() WHERE id = $1`, [userId, clean, token]);
  await db.query(
    `INSERT INTO customer_emails (user_id, kind, to_email) VALUES ($1, 'confirm', $2)`, [userId, clean]);
  return { changed: true };
}

/**
 * Queue the thank-you email for a payment (user, 2026-09-22).
 *
 * Called once money is confirmed, from the one place that knows a payment
 * succeeded. The unique index on payment_id is what makes it once-only: a
 * webhook retry, or the reconciler recovering the same payment, queues nothing
 * new. The address is resolved at SENDING time, not here, so someone who adds
 * their email a minute after paying still gets it.
 */
async function queuePurchase(userId, paymentId) {
  if (!userId || !paymentId) return { queued: false };
  const row = await db.one(
    `INSERT INTO customer_emails (user_id, kind, payment_id, to_email)
     SELECT $1, 'purchase', $2, u.email FROM users u WHERE u.id = $1
     ON CONFLICT (payment_id) WHERE kind = 'purchase' DO NOTHING
     RETURNING id`, [userId, paymentId]);
  return { queued: !!row };
}

/** The addresses customer email may go to while testing; empty means everyone. */
async function onlyTo() {
  return String(await settings.get('customer_email_only_to', '') || '')
    .split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'));
}

/** Send one customer email, honouring test mode. Returns { ok, skipped?, error? }. */
async function deliver(to, mail, token) {
  const allowed = await onlyTo();
  if (allowed.length && !allowed.includes(String(to).toLowerCase())) {
    return { ok: false, skipped: true, error: 'test mode: address not in customer_email_only_to' };
  }
  const headers = token ? {
    'List-Unsubscribe': `<${API()}/email/unsubscribe/${token}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  } : {};
  return mailer.send({
    to, subject: mail.subject, html: mail.html, text: mail.text, headers,
    // A purchase email carries the report and the invoice; the rest carry nothing.
    attachments: mail.attachments || [],
    // ... and answers to a mailbox a person reads, since the sender does not.
    replyTo: mail.replyTo,
  });
}

/* ───────────────────────────────────────────────────────── the record ── */

/** A vehicle's stored record, in the gateway's shape, for vehicleView. */
async function storedRecord(vehicleId) {
  const v = await db.one(`SELECT id, reg_no FROM vehicles WHERE id = $1`, [vehicleId]);
  if (!v) return null;
  const { rows } = await db.query(
    `SELECT dataset, data, fetched_at FROM vehicle_snapshots WHERE vehicle_id = $1`, [vehicleId]);
  const by = Object.fromEntries(rows.map((r) => [r.dataset, r]));
  if (!by.rc) return null;
  const fetched = rows.map((r) => new Date(r.fetched_at)).sort((a, b) => b - a)[0];
  return {
    vehicle_number: v.reg_no, rc: by.rc.data || {}, challans: by.challan?.data || null,
    fastag: by.fastag?.data || null, fetched_at: fetched ? fetched.toISOString() : null,
    rc_checked_at: by.rc.fetched_at, challan_checked_at: by.challan?.fetched_at || null,
  };
}

/* ─────────────────────────────────────────────────────────── pieces ── */

const COLOURS = { expired: '#b42318', due: '#b54708', valid: '#067647' };
const pill = (text, state) =>
  `<span style="color:${COLOURS[state] || '#0b1f1c'};font-weight:700;">${esc(text)}</span>`;

const dataNote = () => `<div style="font-size:12px;line-height:1.55;color:#41514e;background:#f6faf9;border:1px solid #e3ecea;border-radius:8px;padding:10px 12px;">
  <b>Official Government data.</b> Vehicle and challan details come directly from the Government of India's
  Parivahan records (VAHAN and e-Challan) and are shown exactly as received. If anything differs from your
  documents, please verify it with your local RTO — the RTO's record prevails.</div>`;

const vehicleTitle = (v) => [v.identity?.maker, v.identity?.model].filter(Boolean).join(' ') || 'Vehicle';

/** Sections for one PAID vehicle: every document, challan, ownership and FASTag detail. */
function fullSections(v, extra = {}) {
  const head = `${v.pretty || v.reg_no} · ${vehicleTitle(v)}`;
  const docs = (v.documents || []).map((d) => [d.label, {
    html: pill(d.state === 'expired' ? `Expired ${report.human(d.days)}` : `Valid till ${istDay(d.valid_until)}`, d.state)
      + (d.state === 'expired' ? ` <span style="color:#6b8380;font-weight:400;">(${esc(istDay(d.valid_until))})</span>`
        : ` <span style="color:#6b8380;font-weight:400;">(${esc(report.human(d.days))})</span>`),
    text: d.state === 'expired' ? `Expired ${report.human(d.days)} (${istDay(d.valid_until)})` : `Valid till ${istDay(d.valid_until)} (${report.human(d.days)})`,
  }]);
  const c = v.challans || {};
  const pending = (c.pending || []).slice(0, 8).map((p) => [
    `${istDay(p.date)}${p.place ? ` · ${p.place}` : ''}`,
    `${p.offence || 'Challan'} — ${p.amount_paise != null ? rupees(p.amount_paise) : 'amount not given'} (${p.status})`]);
  const o = v.ownership || {};
  const tags = (v.fastag?.tags || []).map((t) => [`FASTag ${t.tag_id || ''}`.trim(),
    { html: pill(t.status || (t.active ? 'Active' : 'Inactive'), t.active ? 'valid' : 'expired'),
      text: t.status || (t.active ? 'Active' : 'Inactive') }]);
  return [
    { heading: `${head} — documents`, rows: docs.length ? docs : [['Documents', 'No dates on the Government record']] },
    { heading: `${head} — challans`, rows: [
      ['Pending challans', c.pending_count ? { html: pill(`${c.pending_count} pending · ${rupees(c.pending_amount_paise)}`, 'expired'), text: `${c.pending_count} pending · ${rupees(c.pending_amount_paise)}` } : { html: pill('None pending', 'valid'), text: 'None pending' }],
      ...pending,
      ...((c.pending || []).length > 8 ? [['…', `${c.pending.length - 8} more in your GaadiPe account`]] : []),
      ['Paid / disposed', c.disposed_count ? String(c.disposed_count) : '0'],
    ] },
    { heading: `${head} — ownership & FASTag`, rows: [
      ['Owner number', o.owner_serial != null ? String(o.owner_serial) : null],
      ['Loan / hypothecation', o.financer || 'None recorded'],
      ['Blacklist', o.blacklist_status || 'Not blacklisted'],
      ['NOC', o.noc_details || null],
      ['Registered at', v.identity?.registered_at || null],
      ...tags,
      ['Alerts until', extra.alertsUntil ? istDay(extra.alertsUntil) : null],
      ['Last Government check', v.checked_at ? istDay(v.checked_at) : null],
    ] },
  ];
}

/** Rows for one vehicle NOT paid for: what the free check shows, nothing more. */
function basicSection(v) {
  const f = v.found || {};
  // The email says exactly what the free check says (free_view_detail).
  if (v.detail === 'none' || v.detail === 'count') {
    return {
      heading: `${v.pretty || v.reg_no} · ${vehicleTitle(v)}`,
      rows: [
        ['Fuel · class', [v.identity?.fuel, v.identity?.vehicle_class].filter(Boolean).join(' · ') || null],
        ['Needs attention', f.needs_attention
          ? { html: pill(`${f.needs_attention} thing${f.needs_attention === 1 ? '' : 's'} on this vehicle`, 'expired'),
              text: `${f.needs_attention} things on this vehicle` }
          : v.detail === 'count' ? 'Nothing found needing attention' : null],
        ['Full report', { html: `<a href="${esc(`${SITE()}/app/vehicle/${encodeURIComponent(v.reg_no)}`)}" style="color:#0f766e;font-weight:700;">See what they are →</a>`,
          text: `${SITE()}/app/vehicle/${v.reg_no}` }],
      ],
    };
  }
  return {
    heading: `${v.pretty || v.reg_no} · ${vehicleTitle(v)}`,
    rows: [
      ['Fuel · class', [v.identity?.fuel, v.identity?.vehicle_class].filter(Boolean).join(' · ') || null],
      ['Expired', f.expired?.length ? { html: pill(f.expired.join(', '), 'expired'), text: f.expired.join(', ') } : 'Nothing expired'],
      ['Due soon', f.due_soon?.length ? { html: pill(f.due_soon.join(', '), 'due'), text: f.due_soon.join(', ') } : 'Nothing due in 60 days'],
      ['Pending challans', f.challans_pending ? { html: pill(String(f.challans_pending), 'expired'), text: String(f.challans_pending) } : '0'],
      ['Full report', { html: `<a href="${esc(`${SITE()}/app/vehicle/${encodeURIComponent(v.reg_no)}`)}" style="color:#0f766e;font-weight:700;">See dates, amounts, loan & FASTag →</a>`, text: `${SITE()}/app/vehicle/${v.reg_no}` }],
    ],
  };
}

const footerFor = (token, why) => `${esc(why)}
  <a href="${esc(`${API()}/email/unsubscribe/${token}`)}" style="color:#0f766e;">Unsubscribe</a> ·
  <a href="${esc(`${SITE()}/app/profile`)}" style="color:#0f766e;">Change your email</a>`;

/* ─────────────────────────────────────────────────────────── builders ── */

function confirmMail(user) {
  const url = `${API()}/email/confirm/${user.email_token}`;
  const name = String(user.display_name || '').split(' ')[0] || 'there';
  const out = T.layout({
    tagline: 'Confirm your email',
    badge: { text: 'One click', tone: 'info' },
    title: 'Confirm your email for vehicle updates',
    lead: `Hi ${name}, please confirm this address so GaadiPe can email you updates about your vehicles — documents expiring, new challans and more.`,
    cta: { label: 'Confirm my email', url },
    blocks: [`<div style="font-size:12px;color:#6b8380;">Or open this link: <a href="${esc(url)}" style="color:#0f766e;word-break:break-all;">${esc(url)}</a><br>If you did not ask for this, ignore this email — nothing will be sent to you.</div>`],
    footer: 'You are receiving this because this address was entered on gaadipe.in.',
    footerHtml: '',
  });
  return { subject: 'Confirm your email — GaadiPe', ...out };
}

/**
 * The paying customer's daily email.
 * paid:    [{ record, alertsUntil }]      vehicles with an active subscription
 * changes: [{ reg_no, text }]              findings not yet emailed
 * others:  [record]                        other vehicles they checked (basic)
 */
function dailyMail(user, { paid, changes = [], others = [] }) {
  const name = String(user.display_name || '').split(' ')[0] || 'there';
  const fullViews = paid.map((p) => ({ v: view.full(p.record), alertsUntil: p.alertsUntil }));
  const expired = fullViews.reduce((n, { v }) => n + (v.documents || []).filter((d) => d.state === 'expired').length, 0);
  const due = fullViews.reduce((n, { v }) => n + (v.documents || []).filter((d) => d.state === 'due').length, 0);
  const challans = fullViews.reduce((n, { v }) => n + (v.challans?.pending_count || 0), 0);
  const changeHtml = changes.length
    ? `<div style="background:#fff6e6;border-left:4px solid #e08700;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.6;color:#0b1f1c;">
        <b>What changed</b><br>${changes.map((c) => `• <b>${esc(c.reg_no)}</b> — ${esc(c.text)}`).join('<br>')}</div>`
    : `<div style="background:#e9f8ef;border-left:4px solid #12a150;border-radius:8px;padding:12px 14px;font-size:14px;color:#0a6c34;"><b>All clear</b> — nothing new since your last update.</div>`;
  const regs = paid.map((p) => p.record.vehicle_number);
  const out = T.layout({
    tagline: 'Your vehicle update',
    preheader: changes.length ? changes.map((c) => `${c.reg_no}: ${c.text}`).join(' · ') : 'All clear — nothing new today.',
    badge: changes.length ? { text: `${changes.length} update${changes.length === 1 ? '' : 's'}`, tone: 'watch' } : { text: 'All clear', tone: 'good' },
    title: `Your vehicle update — ${istDay(new Date())}`,
    lead: `Hi ${name}, here is today's status of ${regs.length === 1 ? regs[0] : `your ${regs.length} vehicles`}.`,
    stats: [['Vehicles', String(regs.length)], ['Expired', String(expired)], ['Due soon', String(due)], ['Challans', String(challans)]],
    intro: [changeHtml],
    sections: [
      ...fullViews.flatMap(({ v, alertsUntil }) => fullSections(v, { alertsUntil })),
      ...others.map((r) => basicSection(view.basic(r, { detail: 'labels' }))),
    ],
    cta: { label: 'Open GaadiPe', url: regs.length === 1 ? `${SITE()}/app/vehicle/${encodeURIComponent(regs[0])}` : `${SITE()}/app` },
    footer: 'You are receiving this daily because you bought a GaadiPe report and it includes alerts.',
    footerHtml: footerFor(user.email_token, ''),
  });
  // The data note sits after the vehicles, before the button.
  out.html = out.html.replace('<tr><td style="padding:24px 28px 8px 28px;" align="left">',
    `<tr><td style="padding:18px 28px 0 28px;">${dataNote()}</td></tr><tr><td style="padding:24px 28px 8px 28px;" align="left">`);
  out.text += '\n\nOfficial Government data from Parivahan (VAHAN and e-Challan). If anything differs from your documents, verify with your local RTO.'
    + `\nUnsubscribe: ${API()}/email/unsubscribe/${user.email_token}`;
  const subject = changes.length
    ? `${changes[0].reg_no}: ${changes[0].text}${changes.length > 1 ? ` +${changes.length - 1} more` : ''} — GaadiPe`
    : `All clear for ${regs.length === 1 ? regs[0] : `your ${regs.length} vehicles`} — GaadiPe daily update`;
  return { subject, ...out };
}

/** The every-few-days email for a customer who has not paid: basic view only. */
function digestMail(user, records, { detail = 'count' } = {}) {
  const name = String(user.display_name || '').split(' ')[0] || 'there';
  const views = records.map((r) => view.basic(r, { detail }));
  const attention = views.filter((v) => v.found?.expired?.length || v.found?.challans_pending).length;
  const price = user.price_paise ? rupees(user.price_paise) : '₹19';
  const out = T.layout({
    tagline: 'Your vehicles',
    preheader: attention ? `${attention} of your vehicles need attention` : 'A quick look at the vehicles you checked',
    badge: attention ? { text: 'Needs attention', tone: 'watch' } : { text: 'Your vehicles', tone: 'info' },
    title: attention ? `${attention} vehicle${attention === 1 ? '' : 's'} you checked need${attention === 1 ? 's' : ''} attention`
      : 'The vehicles you checked on GaadiPe',
    lead: `Hi ${name}, here is where the vehicles you checked stand, from the last Government record GaadiPe fetched.`,
    sections: views.map(basicSection),
    blocks: [`<div style="font-size:13px;line-height:1.6;color:#0b1f1c;background:#e7f3f2;border-radius:8px;padding:12px 14px;">
      <b>Want the dates, amounts and daily alerts?</b> The full report shows every expiry date, each challan with its amount,
      loan / blacklist / NOC and FASTag. Then it watches for new challans for three months, and warns you before
      insurance, PUC, road tax or fitness runs out — whenever that is. <b>${esc(price)}</b> one time, nothing renews.</div>`,
      dataNote()],
    cta: { label: `Get the full report for ${price}`, url: views.length === 1 ? `${SITE()}/app/vehicle/${encodeURIComponent(views[0].reg_no)}` : `${SITE()}/app` },
    footer: 'You are receiving this every few days because you checked these vehicles on gaadipe.in.',
    footerHtml: footerFor(user.email_token, ''),
  });
  out.text += `\nUnsubscribe: ${API()}/email/unsubscribe/${user.email_token}`;
  const subject = attention
    ? `${views.find((v) => v.found?.expired?.length || v.found?.challans_pending).reg_no} needs attention — GaadiPe`
    : 'Your vehicles on GaadiPe';
  return { subject, ...out };
}

/** The referrer's reward: a free full report is waiting (never sent to the parent). */
function rewardMail(user, { count = 0, reduced = 0, reducedPrice = null, expiresAt }) {
  const name = String(user.display_name || '').split(' ')[0] || 'there';
  const price = reducedPrice ? `₹${(reducedPrice / 100).toFixed(2)}` : '₹10.62';
  // Premium through the link = a free report; the Instant Quiz = a report at Rs.9 + GST.
  const parts = [
    count ? `${count} free full report${count > 1 ? 's' : ''}` : null,
    reduced ? `${reduced} full report${reduced > 1 ? 's' : ''} at ${price} (₹9 + GST) instead of ₹19` : null,
  ].filter(Boolean);
  const onlyFree = count && !reduced;
  const out = T.layout({
    tagline: 'Referral reward',
    badge: { text: onlyFree ? (count > 1 ? `${count} free reports earned` : 'Free report earned') : 'Referral reward earned', tone: 'good' },
    title: onlyFree ? (count > 1 ? `${count} free full vehicle reports are ready` : 'Your free full vehicle report is ready')
      : 'Your referral reward is ready',
    lead: `Hi ${name}, parents joined QuizPe through your link — thank you! You have earned ${parts.join(' and ')}.`,
    blocks: [`<div style="font-size:13px;line-height:1.6;color:#0b1f1c;background:#e9f8ef;border-radius:8px;padding:12px 14px;">
      ${count ? 'Open any vehicle you have checked and tap <b>Use my free report</b>: the full record, the PDF, three months of challan watching and expiry warnings — exactly as a paid report.<br>' : ''}
      ${reduced ? `Your next full report costs <b>${esc(price)}</b> — it is applied automatically when you buy, with a GST invoice.<br>` : ''}
      Use ${count + reduced > 1 ? 'them' : 'it'} by <b>${esc(istDay(expiresAt))}</b>.</div>`],
    cta: { label: count ? 'Use my free report' : 'Get my report', url: `${SITE()}/app` },
    footer: 'You are receiving this because you shared your GaadiPe referral link for QuizPe.',
    footerHtml: footerFor(user.email_token, ''),
  });
  out.text += `\nUnsubscribe: ${API()}/email/unsubscribe/${user.email_token}`;
  const subject = onlyFree
    ? (count > 1 ? `${count} free vehicle reports are ready — GaadiPe` : 'Your free vehicle report is ready — GaadiPe')
    : 'Your referral reward is ready — GaadiPe';
  return { subject, ...out };
}

/**
 * The thank-you email, sent once a payment is confirmed (user, 2026-09-22).
 *
 * WHY IT CARRIES THE FILES. GaadiPe has no working WhatsApp Business number
 * yet, so the receipt, the report and the invoice that notifyPaid tries to send
 * on WhatsApp reach nobody. Email is the only channel a paying customer has,
 * and so this email carries both PDFs itself rather than pointing at them: a
 * customer who has paid must end up holding what they bought, whatever else is
 * down.
 *
 * IT GOES TO THE ADDRESS GIVEN AT CHECKOUT, confirmed or not. The confirmation
 * rule exists so a typo never mails somebody else's vehicle record to a
 * stranger — but here the alternative is that the person who actually paid
 * receives nothing at all, which is worse. Confirming still matters for the
 * daily updates, and this email asks for it.
 *
 * It is a receipt, not an update: what was paid, what it bought, where to open
 * it again, until when, and how to reach a person.
 */
function purchaseMail(user, p = {}) {
  const name = String(user.display_name || '').split(' ')[0] || 'there';
  const money = (paise) => `₹${(Number(paise || 0) / 100).toFixed(Number(paise || 0) % 100 ? 2 : 0)}`;
  const reg = p.regNo || 'your vehicle';
  const what = [p.maker, p.model].filter(Boolean).join(' ');
  const link = p.reportToken
    ? `${API()}/report/${p.reportToken}`
    : `${SITE()}/app/vehicle/${encodeURIComponent(p.regNo || '')}`;

  const stats = [
    ['Paid', money(p.amountPaise)],
    p.reportNumber ? ['Report', p.reportNumber] : null,
    p.validUntil ? ['Download until', istDay(p.validUntil)] : null,
    p.alertsUntil ? ['Alerts until', istDay(p.alertsUntil)] : null,
  ].filter(Boolean);

  const attached = [
    p.reportNumber ? `the full report <b>${esc(p.reportNumber)}</b>` : null,
    p.invoiceNumber ? `tax invoice <b>${esc(p.invoiceNumber)}</b> for ${esc(money(p.invoiceTotalPaise || p.amountPaise))} (inclusive of GST)` : null,
  ].filter(Boolean);

  const files = attached.length
    ? `<div style="font-size:13px;line-height:1.7;color:#0b1f1c;background:#e9f8ef;border-left:4px solid #12a150;border-radius:8px;padding:12px 14px;">
        <b>Attached to this email:</b> ${attached.join(' and ')}. They are yours to keep.
        ${p.validUntil ? `You can also download the report again from the button below until <b>${esc(istDay(p.validUntil))}</b>.` : ''}</div>`
    : `<div style="font-size:13px;line-height:1.6;color:#41514e;background:#fff6e6;border-left:4px solid #e08700;border-radius:8px;padding:12px 14px;">
        The Government records service is slow at the moment, so your report is still being prepared.
        Open GaadiPe from the button below in a few minutes and it will be there. Your payment is safe.</div>`;

  const included = `<div style="font-size:13px;line-height:1.7;color:#0b1f1c;background:#f6faf9;border:1px solid #e3ecea;border-radius:10px;padding:14px 16px;">
    <b>What your report includes</b><br>
    • Every document — insurance, PUC, road tax, fitness and permit, with its expiry date<br>
    • Every pending challan, with the offence, the place and the amount<br>
    • Loan / hypothecation, blacklist and NOC status<br>
    • FASTag status and balance, RTO, registration date and number of owners<br>
    • A dated PDF you can keep${p.alertsUntil ? `, new challans watched until <b>${esc(istDay(p.alertsUntil))}</b>` : ''}<br>
    • A warning before insurance, PUC, road tax or fitness expires — however far off that is</div>`;

  const confirm = p.confirmed || !user.email_token ? '' :
    `<div style="font-size:13px;line-height:1.6;color:#41514e;">
      <b>One more thing.</b> This address is not confirmed yet.
      <a href="${esc(`${API()}/email/confirm/${user.email_token}`)}" style="color:#0f766e;font-weight:700;">Confirm it in one click</a>
      so the daily updates for ${esc(reg)} reach you here.</div>`;

  const help = `<div style="font-size:13px;line-height:1.6;color:#41514e;">
    If anything is missing or looks wrong, write to <a href="mailto:${esc(SUPPORT)}" style="color:#0f766e;font-weight:700;">${esc(SUPPORT)}</a>
    and a person will answer.
    GaadiPe shows Government records (VAHAN, e-Challan, NETC FASTag) exactly as received; where they differ from your
    documents, your RTO's record prevails.</div>`;

  const out = T.layout({
    tagline: 'Your purchase',
    preheader: `Thank you — your full report for ${reg} is attached.`,
    badge: { text: 'Payment received', tone: 'good' },
    title: 'Thank you for your purchase',
    lead: `Hi ${name}, we have received your payment of ${money(p.amountPaise)}. Your full report for `
      + `${reg}${what ? ` (${what})` : ''} is ready.`,
    stats,
    blocks: [files, included, confirm, help].filter(Boolean),
    cta: { label: 'Open my report', url: link },
    footer: 'You are receiving this because this address was given when you bought a report on gaadipe.in. It is a purchase confirmation, not a marketing email.',
    footerHtml: '',
  });
  out.text += `\nOpen your report: ${link}\nQuestions: ${SUPPORT}`;
  // Replies go to a mailbox a person reads, not to the noreply sender.
  return { subject: `Thank you — your report for ${reg} is ready`, ...out,
           attachments: p.attachments || [], replyTo: SUPPORT };
}

/**
 * An announcement the admin wrote in the panel (user, 2026-09-21). The text is
 * plain: blank lines make paragraphs, web addresses become links, {name} is
 * the customer's first name. Nothing the admin types is treated as HTML.
 */
function announcementMail(user, { subject, body }) {
  const first = String(user.display_name || '').split(' ')[0] || 'there';
  const text = String(body || '').replace(/\{name\}/g, first);
  const link = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#0f766e;">${u}</a>`);
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 12px 0;font-size:14px;line-height:1.65;color:#0b1f1c;">${link(p).replace(/\n/g, '<br>')}</p>`);
  const out = T.layout({
    tagline: 'From GaadiPe',
    title: String(subject || '').replace(/\{name\}/g, first),
    blocks: [paras.join('')],
    footer: 'You are receiving this announcement because you have a GaadiPe account with a confirmed email address.',
    footerHtml: user.email_token ? footerFor(user.email_token, '') : '',
  });
  out.text = `${String(subject || '').replace(/\{name\}/g, first)}\n\n${text}\n\nUnsubscribe: ${API()}/email/unsubscribe/${user.email_token}`;
  return { subject: String(subject || '').replace(/\{name\}/g, first), ...out };
}

module.exports = {
  setEmail, validEmail, onlyTo, deliver, storedRecord, queuePurchase,
  confirmMail, dailyMail, digestMail, rewardMail, purchaseMail, announcementMail, istDay, SITE, API,
};
