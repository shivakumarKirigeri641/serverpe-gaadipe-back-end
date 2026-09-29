/**
 * src/fleet/fleets.js — GaadiPe for fleets (user, 2026-09-29).
 *
 *   draft ──quote──► quoted ──paid──► paid ──approve──► active ──ends──► expired
 *                                                         │  ▲              │
 *                                                       pause│resume     renewal paid
 *                                                         ▼  │              │
 *                                                        paused ◄──────────┘ (→ active)
 *
 * The owner emails support@gaadipe.in; the admin creates the fleet here from
 * that email, sends a quotation (a Razorpay link, count × ₹19 suggested), and
 * approves it once paid. Every step is kept in fleet_events for the timeline.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const settings = require('../util/settings');
const plate = require('../util/plate');
const mailer = require('../mail/mailer');
const M = require('./mail');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const DAY = 86400000;

async function event(fleetId, kind, text, detail = {}, adminId = null) {
  await db.query(`INSERT INTO fleet_events (fleet_id, kind, text, detail, admin_id) VALUES ($1, $2, $3, $4, $5)`,
    [fleetId, kind, text, JSON.stringify(detail), adminId || null]);
}

/** Vehicle numbers from pasted text — one per line (or comma-separated). */
function parsePlates(text) {
  const ok = []; const invalid = []; const seen = new Set();
  for (const chunk of String(text || '').split(/[\n,;]+/)) {
    if (!chunk.trim()) continue;
    const p = plate.parse(chunk);
    if (!p.ok) { invalid.push({ input: chunk.trim().slice(0, 30), error: p.error }); continue; }
    if (!seen.has(p.regNo)) { seen.add(p.regNo); ok.push(p.regNo); }
  }
  return { ok, invalid };
}

function clean(body = {}) {
  const f = {
    company: clip(body.company, 120), contact_name: clip(body.contact_name, 80) || null,
    email: clip(body.email, 160).toLowerCase(), cc_emails: clip(body.cc_emails, 400) || null,
    gstin: clip(body.gstin, 15).toUpperCase() || null, mobile: String(body.mobile || '').replace(/\D/g, '').slice(-10) || null,
    state_code: String(body.state_code || '').replace(/\D/g, '').slice(0, 2) || null, notes: String(body.notes || '').slice(0, 2000) || null,
  };
  if (f.company.length < 2) return { error: 'Enter the company name.' };
  if (!EMAIL_RE.test(f.email)) return { error: 'Enter a valid email for the daily report.' };
  if (f.cc_emails && f.cc_emails.split(/[,;\s]+/).filter(Boolean).some((e) => !EMAIL_RE.test(e))) return { error: 'One of the extra emails is not valid.' };
  if (f.gstin && !GSTIN_RE.test(f.gstin)) return { error: 'That GSTIN does not look right.' };
  if (f.gstin && !f.state_code) f.state_code = f.gstin.slice(0, 2);   // a GSTIN starts with its state code
  return { f };
}

/* ─────────────────────────────────────────────────────────── reading ── */

async function list({ status } = {}) {
  const { rows } = await db.query(
    `SELECT f.*,
            (SELECT count(*)::int FROM fleet_vehicles v WHERE v.fleet_id = f.id AND v.removed_at IS NULL) AS vehicles,
            (SELECT count(*)::int FROM fleet_vehicles v WHERE v.fleet_id = f.id AND v.removed_at IS NULL AND v.last_check_ok) AS checked_ok,
            (SELECT max(ist_date) FROM fleet_reports r WHERE r.fleet_id = f.id AND r.status = 'sent') AS last_report,
            (SELECT coalesce(sum(amount_paise), 0)::int FROM fleet_payments p WHERE p.fleet_id = f.id AND p.status = 'paid') AS paid_paise,
            (SELECT row_to_json(p) FROM (SELECT id, kind, status, amount_paise, created_at, expires_at, paid_at FROM fleet_payments p
               WHERE p.fleet_id = f.id ORDER BY p.id DESC LIMIT 1) p) AS last_payment
       FROM fleets f
      WHERE ($1::text IS NULL OR f.status = $1)
      ORDER BY CASE f.status WHEN 'paid' THEN 0 WHEN 'quoted' THEN 1 WHEN 'active' THEN 2 WHEN 'draft' THEN 3 ELSE 4 END, f.modified_at DESC`,
    [status || null]);
  const counts = (await db.query(`SELECT status, count(*)::int n FROM fleets GROUP BY 1`)).rows;
  return { rows: rows.map((r) => ({ ...r, id: String(r.id) })), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
}

async function get(id) {
  const fleet = await db.one(`SELECT * FROM fleets WHERE id = $1`, [id]);
  if (!fleet) return null;
  const [vehicles, payments, reports, events] = await Promise.all([
    db.query(`SELECT * FROM fleet_vehicles WHERE fleet_id = $1 ORDER BY removed_at IS NOT NULL, reg_no`, [id]),
    db.query(`SELECT fp.*, i.invoice_number FROM fleet_payments fp LEFT JOIN invoices i ON i.id = fp.invoice_id
               WHERE fp.fleet_id = $1 ORDER BY fp.id DESC`, [id]),
    db.query(`SELECT id, ist_date, status, sent_to, error, vehicles, created_at FROM fleet_reports WHERE fleet_id = $1 ORDER BY ist_date DESC LIMIT 60`, [id]),
    db.query(`SELECT e.*, a.name AS admin_name FROM fleet_events e LEFT JOIN admin_users a ON a.id = e.admin_id
               WHERE e.fleet_id = $1 ORDER BY e.at DESC LIMIT 200`, [id]),
  ]);
  const live = vehicles.rows.filter((v) => !v.removed_at);
  const status = await require('./status').fleetStatus(id).catch(() => []);
  return {
    fleet: { ...fleet, id: String(fleet.id) },
    vehicles: vehicles.rows.map((v) => ({ ...v, id: String(v.id), status: status.find((s) => s.reg_no === v.reg_no && !v.removed_at) || null })),
    payments: payments.rows.map((p) => ({ ...p, id: String(p.id) })),
    reports: reports.rows,
    events: events.rows,
    suggest: { price_per_vehicle_paise: await settings.num('fleet_price_per_vehicle_paise', 1900),
               amount_paise: live.length * await settings.num('fleet_price_per_vehicle_paise', 1900),
               min_vehicles: await settings.num('fleet_min_vehicles', 5), period_days: await settings.num('fleet_period_days', 28) },
  };
}

/* ─────────────────────────────────────────────────────────── writing ── */

async function create(body, admin) {
  const { f, error } = clean(body);
  if (error) return { ok: false, message: error };
  const { ok: plates, invalid } = parsePlates(body.vehicles);
  const fleet = await db.one(
    `INSERT INTO fleets (company, contact_name, email, cc_emails, gstin, mobile, state_code, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [f.company, f.contact_name, f.email, f.cc_emails, f.gstin, f.mobile, f.state_code, f.notes, admin?.id || null]);
  for (const reg of plates) {
    await db.query(`INSERT INTO fleet_vehicles (fleet_id, reg_no, vehicle_id)
                    VALUES ($1, $2, (SELECT id FROM vehicles WHERE reg_no = $2)) ON CONFLICT DO NOTHING`, [fleet.id, reg]);
  }
  await event(fleet.id, 'created', `Fleet created with ${plates.length} vehicle${plates.length === 1 ? '' : 's'}`, { invalid }, admin?.id);
  return { ok: true, id: String(fleet.id), vehicles: plates.length, invalid };
}

async function update(id, body, admin) {
  const { f, error } = clean(body);
  if (error) return { ok: false, message: error };
  const row = await db.one(
    `UPDATE fleets SET company = $2, contact_name = $3, email = $4, cc_emails = $5, gstin = $6, mobile = $7,
            state_code = $8, notes = $9, modified_at = now() WHERE id = $1 RETURNING id`,
    [id, f.company, f.contact_name, f.email, f.cc_emails, f.gstin, f.mobile, f.state_code, f.notes]);
  if (!row) return { ok: false, message: 'No such fleet.' };
  await event(id, 'edited', 'Details edited', {}, admin?.id);
  return { ok: true };
}

/** Add or remove vehicles. A removed vehicle keeps its row (history). */
async function changeVehicles(id, { add = '', remove = [] } = {}, admin) {
  const fleet = await db.one(`SELECT id FROM fleets WHERE id = $1`, [id]);
  if (!fleet) return { ok: false, message: 'No such fleet.' };
  const { ok: plates, invalid } = parsePlates(add);
  const added = [];
  for (const reg of plates) {
    const r = await db.one(`INSERT INTO fleet_vehicles (fleet_id, reg_no, vehicle_id)
                            VALUES ($1, $2, (SELECT id FROM vehicles WHERE reg_no = $2)) ON CONFLICT DO NOTHING RETURNING reg_no`, [id, reg]);
    if (r) added.push(reg);
  }
  const removed = [];
  for (const reg of [].concat(remove).map((r) => String(r).toUpperCase())) {
    const r = await db.one(`UPDATE fleet_vehicles SET removed_at = now() WHERE fleet_id = $1 AND reg_no = $2 AND removed_at IS NULL RETURNING reg_no`, [id, reg]);
    if (r) removed.push(reg);
  }
  if (added.length || removed.length) {
    await db.query(`UPDATE fleets SET modified_at = now() WHERE id = $1`, [id]);
    await event(id, 'vehicles', [added.length ? `Added ${added.join(', ')}` : null, removed.length ? `Removed ${removed.join(', ')}` : null].filter(Boolean).join(' · '),
      { added, removed, invalid }, admin?.id);
  }
  return { ok: true, added, removed, invalid };
}

/** Send a quotation (or renewal): a Razorpay link, emailed. */
async function quote(id, { amountPaise } = {}, admin) {
  const fleet = await db.one(`SELECT * FROM fleets WHERE id = $1`, [id]);
  if (!fleet) return { ok: false, message: 'No such fleet.' };
  if (fleet.status === 'cancelled') return { ok: false, message: 'This fleet is cancelled.' };
  const vehicles = (await db.query(`SELECT reg_no FROM fleet_vehicles WHERE fleet_id = $1 AND removed_at IS NULL ORDER BY reg_no`, [id])).rows.map((r) => r.reg_no);
  const min = await settings.num('fleet_min_vehicles', 5);
  if (vehicles.length < min) return { ok: false, message: `A fleet needs at least ${min} vehicles (this one has ${vehicles.length}).` };
  const per = await settings.num('fleet_price_per_vehicle_paise', 1900);
  const amount = Math.round(Number(amountPaise) || vehicles.length * per);
  if (amount < 100) return { ok: false, message: 'Enter the amount to quote.' };
  const period = await settings.num('fleet_period_days', 28);
  const days = await settings.num('fleet_link_days', 7);
  const renewal = ['active', 'expired', 'paused'].includes(fleet.status) && fleet.starts_at;

  // Earlier unpaid links for this fleet stop counting.
  await db.query(`UPDATE fleet_payments SET status = 'cancelled' WHERE fleet_id = $1 AND status = 'created'`, [id]);
  const fp = await db.one(
    `INSERT INTO fleet_payments (fleet_id, kind, amount_paise, vehicles, period_days, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7) RETURNING *`,
    [id, renewal ? 'renewal' : 'new', amount, vehicles.length, period, days, admin?.id || null]);

  let link;
  try {
    link = await require('../pay/razorpay').createFleetLink({
      amountPaise: amount, referenceId: `fl-${fp.id}`,
      description: `GaadiPe Fleet · ${fleet.company} · ${vehicles.length} vehicles · ${period} days`,
      name: fleet.contact_name || fleet.company, email: fleet.email, mobile: fleet.mobile,
      notes: { fleet_id: String(id), fleet_payment_id: String(fp.id), company: fleet.company.slice(0, 200) },
      expireBy: fp.expires_at,
    });
  } catch (e) {
    await db.query(`UPDATE fleet_payments SET status = 'cancelled' WHERE id = $1`, [fp.id]);
    return { ok: false, message: `Razorpay refused the link: ${e.message}` };
  }
  const row = await db.one(`UPDATE fleet_payments SET link_id = $2, link_url = $3 WHERE id = $1 RETURNING *`, [fp.id, link.id, link.short_url]);
  if (!renewal) await db.query(`UPDATE fleets SET status = 'quoted', modified_at = now() WHERE id = $1 AND status IN ('draft', 'quoted')`, [id]);

  const out = await mailer.send(M.quotation(fleet, row, vehicles));
  await event(id, renewal ? 'renewal_sent' : 'quoted',
    `${renewal ? 'Renewal link' : 'Quotation'} sent: ${M.rs(amount)} for ${vehicles.length} vehicles, ${period} days${out.ok ? '' : ` — EMAIL FAILED: ${out.error}`}`,
    { fleet_payment_id: String(fp.id), link: row.link_url, emailed: out.ok }, admin?.id);
  return { ok: true, payment: { ...row, id: String(row.id) }, emailed: out.ok, email_error: out.ok ? null : out.error };
}

/** The GST invoice for a fleet payment: one line per vehicle. */
async function invoiceFor(fp, fleet) {
  const existing = await db.one(`SELECT * FROM invoices WHERE fleet_payment_id = $1`, [fp.id]);
  if (existing) return { invoice: existing, pdf: existing.pdf_path && fs.existsSync(existing.pdf_path) ? fs.readFileSync(existing.pdf_path) : null };
  const inv = require('../pay/invoice');
  const business = await db.one(`SELECT * FROM business_details WHERE is_active ORDER BY id DESC LIMIT 1`) || {};
  const gross = fp.amount_paise;
  const base = Math.round(gross / 1.18);
  const tax = gross - base;
  const home = String(business.home_state_code || '29');
  const pos = String(fleet.state_code || home);
  const inter = pos !== home;
  const cgst = inter ? 0 : Math.round(tax / 2); const sgst = inter ? 0 : tax - cgst; const igst = inter ? tax : 0;

  const row = await db.tx(async (c) => {
    const number = await inv.nextNumber(c);
    const { rows } = await c.query(
      `INSERT INTO invoices (user_id, fleet_payment_id, invoice_number, base_paise, gst_percent, cgst_paise, sgst_paise, igst_paise,
                             total_paise, place_of_supply, buyer_name, buyer_gstin, access_token)
       VALUES (NULL, $1, $2, $3, 18, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [fp.id, number, base, cgst, sgst, igst, gross, pos, fleet.company, fleet.gstin, crypto.randomBytes(16).toString('hex')]);
    return rows[0];
  });

  const vehicles = (await db.query(`SELECT reg_no FROM fleet_vehicles WHERE fleet_id = $1 AND removed_at IS NULL ORDER BY reg_no`, [fleet.id])).rows.map((r) => r.reg_no);
  const n = Math.max(1, vehicles.length);
  const each = Math.floor(base / n);
  const lineItems = (vehicles.length ? vehicles : ['Fleet']).map((reg, i) => ({
    reg_no: reg, description: `GaadiPe Fleet monitoring — ${reg} (${fp.period_days} days)`,
    taxable: (i === n - 1 ? base - each * (n - 1) : each) / 100,
  }));
  const pdf = await require('../pdf/invoice').buildInvoice({
    invoice: {
      invoice_number: row.invoice_number, invoice_date: row.invoice_date, customer_name: fleet.company,
      customer_gstin: fleet.gstin, customer_email: fleet.email, customer_mobile: fleet.mobile,
      place_of_supply: inv.STATES[pos] || 'Karnataka', place_of_supply_code: pos, is_interstate: inter, sac_code: '998319',
      taxable_amount: base / 100, cgst_amount: cgst / 100, sgst_amount: sgst / 100, igst_amount: igst / 100,
      total_tax: tax / 100, gross_amount: gross / 100,
    },
    business, gst: { cgst_percent: 9, sgst_percent: 9, igst_percent: 18, sac_code: '998319' },
    lineItems,
    lineItem: { payment_id: fp.razorpay_payment_id, method: 'ONLINE', paid_at: fp.paid_at },
  });
  const dir = path.join(__dirname, '..', 'uploads', 'invoices');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${row.invoice_number}.pdf`);
  fs.writeFileSync(file, pdf);
  await db.query(`UPDATE invoices SET pdf_path = $2 WHERE id = $1`, [row.id, file]);
  await db.query(`UPDATE fleet_payments SET invoice_id = $2 WHERE id = $1`, [fp.id, row.id]);
  return { invoice: { ...row, pdf_path: file }, pdf };
}

/** Razorpay said a fleet link was paid (from the payment webhook). Idempotent. */
async function markPaid(fleetPaymentId, { razorpayPaymentId } = {}) {
  const fp = await db.one(
    `UPDATE fleet_payments SET status = 'paid', paid_at = now(), razorpay_payment_id = $2
      WHERE id = $1 AND status IN ('created', 'expired', 'cancelled') RETURNING *`, [fleetPaymentId, razorpayPaymentId || null]);
  if (!fp) return { ok: false, reason: 'already' };
  let fleet;
  if (fp.kind === 'renewal') {
    const period = fp.period_days;
    fleet = await db.one(
      `UPDATE fleets SET status = CASE WHEN status IN ('active', 'expired', 'paused') THEN 'active' ELSE status END,
              ends_at = greatest(coalesce(ends_at, now()), now()) + make_interval(days => $2), modified_at = now()
        WHERE id = $1 RETURNING *`, [fp.fleet_id, period]);
    await event(fp.fleet_id, 'renewed', `Renewal paid: ${M.rs(fp.amount_paise)} — monitoring until ${require('./status').fmt(new Date(fleet.ends_at))}`, { fleet_payment_id: String(fp.id) });
  } else {
    fleet = await db.one(`UPDATE fleets SET status = CASE WHEN status IN ('draft', 'quoted') THEN 'paid' ELSE status END, modified_at = now()
                           WHERE id = $1 RETURNING *`, [fp.fleet_id]);
    await event(fp.fleet_id, 'paid', `Paid ${M.rs(fp.amount_paise)} — waiting for your approval`, { fleet_payment_id: String(fp.id), razorpay_payment_id: razorpayPaymentId });
  }
  let invoice = null; let pdf = null;
  try { ({ invoice, pdf } = await invoiceFor(fp, fleet)); } catch (e) { console.error('[fleet] invoice for payment %s: %s', fp.id, e.message); }
  const toFleet = await mailer.send(M.paid(fleet, fp, invoice, pdf));
  await mailer.send(M.adminPaid(fleet, fp)).catch(() => {});
  if (invoice) await event(fp.fleet_id, 'invoice', `GST invoice ${invoice.invoice_number} ${toFleet.ok ? 'emailed' : 'NOT emailed: ' + toFleet.error}`, { invoice_id: String(invoice.id) });
  return { ok: true, fleet };
}

async function approve(id, admin) {
  const period = (await db.one(`SELECT period_days FROM fleet_payments WHERE fleet_id = $1 AND status = 'paid' ORDER BY paid_at DESC LIMIT 1`, [id]))?.period_days;
  if (!period) return { ok: false, message: 'There is no payment to approve yet.' };
  const fleet = await db.one(
    `UPDATE fleets SET status = 'active', starts_at = now(), ends_at = now() + make_interval(days => $2),
            approved_at = now(), approved_by = $3, modified_at = now()
      WHERE id = $1 AND status = 'paid' RETURNING *`, [id, period, admin?.id || null]);
  if (!fleet) return { ok: false, message: 'Only a paid fleet can be approved.' };
  const vehicles = (await db.query(`SELECT reg_no FROM fleet_vehicles WHERE fleet_id = $1 AND removed_at IS NULL ORDER BY reg_no`, [id])).rows.map((r) => r.reg_no);
  const out = await mailer.send(M.approved(fleet, vehicles, await settings.num('fleet_report_hour_ist', 19)));
  await event(id, 'approved', `Approved — monitoring ${vehicles.length} vehicles until ${require('./status').fmt(new Date(fleet.ends_at))}${out.ok ? '; confirmation emailed' : ` — EMAIL FAILED: ${out.error}`}`, {}, admin?.id);
  return { ok: true, emailed: out.ok };
}

async function setStatus(id, to, admin) {
  const from = { paused: ['active'], active: ['paused'], cancelled: ['draft', 'quoted', 'paid', 'active', 'paused', 'expired'] }[to];
  if (!from) return { ok: false, message: 'Not allowed.' };
  const fleet = await db.one(
    `UPDATE fleets SET status = $2, modified_at = now() WHERE id = $1 AND status = ANY($3)
        AND ($2 <> 'active' OR ends_at > now()) RETURNING *`, [id, to, from]);
  if (!fleet) return { ok: false, message: to === 'active' ? 'Its period has ended — send a renewal instead.' : 'That change is not possible from its current status.' };
  if (to === 'cancelled') await db.query(`UPDATE fleet_payments SET status = 'cancelled' WHERE fleet_id = $1 AND status = 'created'`, [id]);
  await event(id, to, { paused: 'Paused — no checks or emails', active: 'Resumed', cancelled: 'Cancelled' }[to], {}, admin?.id);
  return { ok: true };
}

async function note(id, text, admin) {
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) return { ok: false, message: 'Write a note.' };
  await event(id, 'note', t, {}, admin?.id);
  return { ok: true };
}

/* ──────────────────────────────────────────────────── the daily report ── */

const istDate = (d = new Date()) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);

/** Build and email one fleet's report now. `force` sends even if today's went. */
async function sendReport(id, { force = false, admin = null } = {}) {
  const fleet = await db.one(`SELECT * FROM fleets WHERE id = $1`, [id]);
  if (!fleet) return { ok: false, message: 'No such fleet.' };
  const S = require('./status');
  const today = istDate();
  let claim = await db.one(
    `INSERT INTO fleet_reports (fleet_id, ist_date) VALUES ($1, $2) ON CONFLICT (fleet_id, ist_date) DO NOTHING RETURNING id`, [id, today]);
  if (!claim && force) claim = await db.one(`UPDATE fleet_reports SET status = 'sending', error = NULL WHERE fleet_id = $1 AND ist_date = $2 RETURNING id`, [id, today]);
  if (!claim) return { ok: false, message: 'Today\'s report was already sent.' };

  const list = await S.fleetStatus(id);
  const prev = await db.one(`SELECT snapshot FROM fleet_reports WHERE fleet_id = $1 AND ist_date < $2 AND status = 'sent' ORDER BY ist_date DESC LIMIT 1`, [id, today]);
  const changes = S.changesSince(prev?.snapshot || null, list);
  const xlsx = await require('./excel').build(fleet, list);
  const out = await mailer.send(M.daily(fleet, list, changes, xlsx));
  await db.query(`UPDATE fleet_reports SET status = $2, sent_to = $3, error = $4, vehicles = $5, snapshot = $6 WHERE id = $1`,
    [claim.id, out.ok ? 'sent' : 'failed', out.to || null, out.ok ? null : String(out.error || '').slice(0, 300), list.length, JSON.stringify(S.snapshotOf(list))]);
  const need = list.filter((v) => v.state === 'attention' || v.state === 'expired').length;
  await event(id, out.ok ? 'report' : 'report_failed', out.ok
    ? `Daily report emailed: ${list.length} vehicles, ${need} need attention${changes.length ? `, ${changes.length} change${changes.length === 1 ? '' : 's'}` : ''}`
    : `Daily report NOT emailed: ${out.error}`, { changes: changes.length }, admin?.id);
  return { ok: out.ok, message: out.ok ? null : out.error };
}

/** The Excel as it would be sent now (admin download / preview). */
async function excelNow(id) {
  const fleet = await db.one(`SELECT * FROM fleets WHERE id = $1`, [id]);
  if (!fleet) return null;
  const list = await require('./status').fleetStatus(id);
  return { buffer: Buffer.from(await require('./excel').build(fleet, list)), company: fleet.company };
}

module.exports = { list, get, create, update, changeVehicles, quote, markPaid, approve, setStatus, note, sendReport, excelNow,
  invoiceFor, parsePlates, event, istDate };
