/**
 * src/fleet/mail.js — every email a fleet receives (user, 2026-09-29).
 * Fleets are dealt with by email only; Reply reaches support@gaadipe.in.
 */

const T = require('../mail/templates');
const { fmt } = require('./status');

const SUPPORT = 'support@gaadipe.in';
const rs = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const recipients = (fleet) => [fleet.email, ...String(fleet.cc_emails || '').split(/[,;\s]+/)]
  .map((s) => s.trim()).filter((s) => /@/.test(s));
const base = (fleet, parts) => ({
  to: recipients(fleet),
  replyTo: SUPPORT,
  ...parts,
});
const layout = (o) => T.layout({ tagline: 'GaadiPe for fleets', repliesWelcome: true,
  footer: 'You receive this because your business uses GaadiPe for fleets.', ...o });

/** The quotation, with the payment link. */
function quotation(fleet, fp, vehicles) {
  const until = fmt(new Date(fp.expires_at));
  return base(fleet, {
    subject: `GaadiPe Fleet quotation · ${fleet.company} · ${plural(fp.vehicles, 'vehicle')} · ${rs(fp.amount_paise)}`,
    ...layout({
      badge: { text: fp.kind === 'renewal' ? 'Renewal' : 'Quotation', tone: 'info' },
      title: fp.kind === 'renewal' ? `Renew monitoring for ${fleet.company}` : `Your GaadiPe Fleet quotation`,
      lead: `Hello ${fleet.contact_name || fleet.company}, thank you for choosing GaadiPe. Here is your plan for `
        + `${plural(fp.vehicles, 'vehicle')}, ${fp.period_days} days of monitoring.`,
      stats: [['Vehicles', String(fp.vehicles)], ['Period', `${fp.period_days} days`], ['Amount', rs(fp.amount_paise)]],
      sections: [
        { heading: 'What you get', rows: [
          ['Every evening', 'One email with an Excel report of every vehicle'],
          ['Checked daily', 'Challans, insurance, PUC (emission test), road tax, fitness, permit, registration'],
          ['Warnings', 'Documents expiring within 30 days are flagged'],
          ['Invoice', `GST invoice${fleet.gstin ? ` with your GSTIN ${fleet.gstin}` : ''}, sent after payment`],
        ] },
        { heading: 'Payment', rows: [
          ['Amount (GST included)', rs(fp.amount_paise)],
          ['Pay by', until],
          ['After payment', fp.kind === 'renewal' ? `Monitoring continues for another ${fp.period_days} days` : 'We review and switch your fleet on — you get a confirmation email'],
        ] },
        { heading: `Vehicles (${vehicles.length})`, rows: [['Numbers', vehicles.join(', ')]] },
      ],
      cta: { label: `Pay ${rs(fp.amount_paise)} securely`, url: fp.link_url },
    }),
  });
}

/** Payment received (with the GST invoice attached). */
function paid(fleet, fp, invoice, pdf) {
  const renewal = fp.kind === 'renewal';
  return base(fleet, {
    subject: `Payment received · GaadiPe Fleet · ${fleet.company}`,
    attachments: pdf ? [{ filename: `${invoice.invoice_number}.pdf`, content: pdf }] : [],
    ...layout({
      badge: { text: 'Payment received', tone: 'good' },
      title: `Thank you — ${rs(fp.amount_paise)} received`,
      lead: renewal
        ? `Monitoring of your ${plural(fp.vehicles, 'vehicle')} continues until ${fmt(new Date(fleet.ends_at))}. Your GST invoice is attached.`
        : 'We are reviewing your fleet now and will switch it on shortly — you will get a confirmation email. Your GST invoice is attached.',
      sections: [{ heading: 'Payment', rows: [
        ['Amount', rs(fp.amount_paise)], ['Vehicles', String(fp.vehicles)], ['Period', `${fp.period_days} days`],
        ['Invoice', invoice?.invoice_number || null], ['Payment ID', fp.razorpay_payment_id || null],
      ] }],
    }),
  });
}

/** Approved: the fleet is on. */
function approved(fleet, vehicles, reportHour) {
  const h = Number(reportHour);
  const at = `${((h + 11) % 12) + 1} ${h < 12 ? 'am' : 'pm'}`;
  return base(fleet, {
    subject: `Your GaadiPe Fleet is active · ${fleet.company}`,
    ...layout({
      badge: { text: 'Fleet approved', tone: 'good' },
      title: `${fleet.company} is now monitored`,
      lead: `Every vehicle is checked daily, and one email with an Excel report of your whole fleet arrives every evening at about ${at}.`,
      stats: [['Vehicles', String(vehicles.length)], ['From', fmt(new Date(fleet.starts_at))], ['Until', fmt(new Date(fleet.ends_at))]],
      sections: [
        { heading: 'The daily report', rows: [
          ['When', `Every evening at about ${at}, to ${recipients(fleet).join(', ')}`],
          ['Excel', 'A row per vehicle, a column per document, coloured green / amber / red'],
          ['In the email', 'A summary: what needs attention and what changed since yesterday'],
        ] },
        { heading: 'Changes', rows: [
          ['Add, remove or replace a vehicle', 'Reply to any GaadiPe email with the vehicle numbers'],
          ['Before the period ends', 'We email you a renewal link a few days ahead'],
        ] },
        { heading: `Vehicles (${vehicles.length})`, rows: [['Numbers', vehicles.join(', ')]] },
      ],
    }),
  });
}

/** The daily summary, with the Excel attached. */
function daily(fleet, list, changes, xlsx, date = new Date()) {
  const need = list.filter((v) => v.state === 'attention' || v.state === 'expired');
  const ok = list.filter((v) => v.state === 'ok').length;
  const pending = list.reduce((n, v) => n + (v.pending || 0), 0);
  const pendingPaise = list.reduce((n, v) => n + (v.pending_paise || 0), 0);
  const actions = list.flatMap((v) => v.issues.map((i) => ({ reg: v.reg_no, ...i })))
    .sort((a, b) => b.level - a.level || (a.days ?? 99999) - (b.days ?? 99999));
  const colour = (lvl) => (lvl === 3 ? '#912018' : '#8f5600');
  const actionRows = actions.slice(0, 15).map((a) => [a.reg, { html: `<span style="color:${colour(a.level)}">${a.level === 3 ? '🔴' : '🟠'} ${T.esc(a.text)}</span>`, text: a.text }]);
  const unchecked = list.filter((v) => v.state === 'unchecked').map((v) => v.reg_no);
  const day = fmt(date);
  return base(fleet, {
    subject: `${need.length ? `⚠️ ${plural(need.length, 'vehicle')} need attention` : '✅ All vehicles fine'} · ${fleet.company} · ${day}`,
    attachments: [{ filename: `GaadiPe-Fleet-${fleet.company.replace(/[^\w]+/g, '-')}-${date.toISOString().slice(0, 10)}.xlsx`, content: Buffer.from(xlsx),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    ...layout({
      badge: need.length ? { text: 'Needs attention', tone: 'watch' } : { text: 'All good', tone: 'good' },
      title: `Fleet status · ${day}`,
      lead: need.length
        ? `${plural(need.length, 'vehicle')} of ${list.length} need attention today. The full status of every vehicle is in the attached Excel.`
        : `All ${plural(list.length, 'vehicle')} are fine today. The full status of every vehicle is in the attached Excel.`,
      stats: [['Vehicles', String(list.length)], ['All good', String(ok)], ['Need attention', String(need.length)],
        ['Pending challans', pending ? `${pending} · ${rs(pendingPaise)}` : '0']],
      sections: [
        actionRows.length ? { heading: `Action needed${actions.length > 15 ? ` (15 of ${actions.length} — all in the Excel)` : ''}`, rows: actionRows } : null,
        changes.length ? { heading: 'Changed since yesterday', rows: changes.slice(0, 20).map((c) => { const [reg, ...rest] = c.split(': '); return [reg, rest.join(': ')]; }) } : null,
        unchecked.length ? { heading: 'Not checked yet', rows: [['Vehicles', `${unchecked.join(', ')} — the Government service did not answer; we try again`]] } : null,
        { heading: 'Your plan', rows: [['Monitoring until', fleet.ends_at ? fmt(new Date(fleet.ends_at)) : null], ['Changes', 'Reply to this email to add, remove or replace a vehicle']] },
      ].filter(Boolean),
    }),
  });
}

/** For the admin: a fleet has paid and waits for approval. */
function adminPaid(fleet, fp) {
  return {
    subject: `🚛 Fleet paid — approve · ${fleet.company} · ${rs(fp.amount_paise)}`,
    ...T.layout({
      badge: { text: fp.kind === 'renewal' ? 'Fleet renewed' : 'Fleet paid — approve', tone: 'good' },
      title: `${fleet.company} paid ${rs(fp.amount_paise)}`,
      lead: fp.kind === 'renewal' ? 'The renewal was paid; monitoring continues automatically.'
        : 'Review the fleet and press Approve to switch it on.',
      sections: [{ heading: 'Fleet', rows: [['Company', fleet.company], ['Email', fleet.email], ['Vehicles', String(fp.vehicles)], ['Period', `${fp.period_days} days`]] }],
      cta: { label: 'Open the fleet', path: `/fleets/${fleet.id}` },
    }),
  };
}

module.exports = { quotation, paid, approved, daily, adminPaid, recipients, rs };
