/**
 * src/admin/customerExport.js — ONE CUSTOMER, EVERYTHING, IN EXCEL (user,
 * 2026-10-08: "export the user, pin to pin — user and vehicles, dates and
 * times, accepted, device info, with graphs and plots").
 *
 * Sheets, in order:
 *   Summary      who they are, where they came from, totals
 *   Charts       daily checks, sign-ins and minutes on the website, money by
 *                month, checks found / failed — real Excel charts (editable),
 *                drawn from the tables on the same sheet
 *   Vehicles     every vehicle checked, every field GaadiPe holds for it
 *   Checks       every vehicle check, with time, found or not, channel
 *   Reports      every full report
 *   Payments     every payment and its invoice
 *   Sign-ins     every sign-in step: time, IP, place, device, browser, OS,
 *                user agent, device id — and the agreement behind it
 *   Sessions     every signed-in session: start, end, how long, how it ended
 *   Visits       every website visit: source, landing, pages, taps, device
 *   Agreements   every Terms / Privacy / Refund, offers and QuizPe consent
 *   Activity     the event trail, newest first
 *
 * Mobile numbers, emails and IPs are masked for an admin without 'pii'.
 * Read-only; the export itself is in the audit log (routes/adminApi.js).
 */

const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const db = require('../db');
const device = require('../site/device');

const C = { brand: 'FF0F766E', brandSoft: 'FFE6F3F1', head: 'FFF3F7F6', body: 'FF41514E', line: 'FFE3ECEA', good: 'FF0A6C34', bad: 'FFB42318' };
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const IST = 'Asia/Kolkata';
const when = (t) => (t ? new Date(t).toLocaleString('en-IN', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : '');
const day = (t) => (t ? new Date(t).toLocaleDateString('en-IN', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric' }) : '');
const ymd = (t) => new Date(new Date(t).getTime() + 330 * 60000).toISOString().slice(0, 10);
const rs = (p) => (p == null ? '' : Math.round(Number(p)) / 100);
const secs = (n) => { n = Math.max(0, Math.round(Number(n) || 0)); const h = Math.floor(n / 3600); const m = Math.floor((n % 3600) / 60); return h ? `${h}h ${m}m` : m ? `${m}m ${n % 60}s` : `${n}s`; };
const parse = (v) => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

/* ─────────────────────────────── the data ─────────────────────────────── */

async function gather(userId) {
  const user = await db.one(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (!user) return null;
  const q = (sql, p = [userId]) => db.query(sql, p).then((r) => r.rows).catch((e) => { console.error('[export] %s', e.message); return []; });
  const CONSENT = require('./customers').CONSENT_OF;
  const [firstVisit, vehicles, checks, reports, payments, signIns, sessions, visits, agreements, activity] = await Promise.all([
    db.one(`SELECT first_touch, last_touch, first_seen_at, device, place FROM visitors WHERE user_id = $1 ORDER BY first_seen_at LIMIT 1`, [userId]).catch(() => null),
    q(`SELECT v.*, uv.check_count, uv.last_checked_at, uv.first_checked_at,
              (SELECT max(r.valid_until) FROM vehicle_reports r WHERE r.user_id = uv.user_id AND r.reg_no = v.reg_no) AS report_until,
              (SELECT count(*) FROM vehicle_reports r WHERE r.user_id = uv.user_id AND r.reg_no = v.reg_no)::int AS reports,
              EXISTS (SELECT 1 FROM watches w WHERE w.user_id = uv.user_id AND w.vehicle_id = v.id AND w.is_active) AS watched
         FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
        WHERE uv.user_id = $1 ORDER BY uv.last_checked_at DESC NULLS LAST`),
    q(`SELECT id, created_at, kind, detail FROM event_log
        WHERE user_id = $1 AND kind IN ('vehicle_check', 'vehicle_check_repeat') ORDER BY id DESC LIMIT 5000`),
    q(`SELECT r.id, r.report_number, r.reg_no, r.created_at, r.valid_until, r.payment_id, r.channel FROM vehicle_reports r
        WHERE r.user_id = $1 ORDER BY r.id DESC`),
    q(`SELECT p.id, p.created_at, p.paid_at, p.status, p.amount_paise, p.gateway, p.order_id, p.payment_id AS gateway_payment_id,
              coalesce(p.raw->>'channel', p.raw->'paid_from'->>'channel', 'whatsapp') AS channel, p.raw->>'reg_no' AS reg_no,
              i.invoice_number, i.invoice_date, i.base_paise, i.cgst_paise, i.sgst_paise, i.igst_paise, i.total_paise
         FROM payments p LEFT JOIN invoices i ON i.payment_id = p.id
        WHERE p.user_id = $1 ORDER BY p.id DESC`),
    q(`SELECT g.*, c.consent_at, c.consent FROM site_sign_ins g
        ${CONSENT("CASE WHEN g.event = 'signed_in' THEN g.user_id END", 'g.created_at')}
        WHERE g.user_id = $1 OR g.mobile = $2 ORDER BY g.id DESC LIMIT 5000`, [userId, String(user.mobile || '').slice(-10)]),
    q(`SELECT ${require('./customers').SESSION_COLS}, c.consent_at FROM site_sessions s
        ${CONSENT('s.user_id', 's.created_at')}
        WHERE s.user_id = $1 ORDER BY s.id DESC LIMIT 5000`),
    q(`SELECT * FROM web_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 5000`),
    q(`SELECT created_at, kind, detail FROM event_log
        WHERE user_id = $1 AND (kind LIKE '%consent%' OR kind IN ('terms_accepted', 'mobile_changed', 'account_deactivated'))
        ORDER BY id DESC LIMIT 2000`),
    q(`SELECT occurred_at, name, channel, reg_no, amount_paise, status, page, source, metadata FROM events
        WHERE user_id = $1 ORDER BY id DESC LIMIT 5000`),
  ]);
  return { user, firstVisit, vehicles, checks, reports, payments, signIns, sessions, visits, agreements, activity };
}

/* ───────────────────────────── the workbook ───────────────────────────── */

/** A sheet with a coloured title, a frozen header row, filters and widths. */
function table(wb, name, title, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 3, showGridLines: false }] });
  ws.columns = columns.map(([, , w]) => ({ width: w || 18 }));
  ws.mergeCells(1, 1, 1, Math.max(1, columns.length));
  const t = ws.getCell(1, 1);
  t.value = title; t.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }; t.fill = fill(C.brand);
  t.alignment = { vertical: 'middle', indent: 1 }; ws.getRow(1).height = 26;
  ws.getCell(2, 1).value = `${rows.length} row${rows.length === 1 ? '' : 's'} · times in IST`;
  ws.getCell(2, 1).font = { size: 10, color: { argb: C.body } };
  const head = ws.getRow(3);
  columns.forEach(([label], i) => {
    const c = head.getCell(i + 1);
    c.value = label; c.font = { bold: true, color: { argb: 'FF0B1F1C' } }; c.fill = fill(C.head);
    c.border = { bottom: { style: 'thin', color: { argb: C.line } } }; c.alignment = { vertical: 'middle', wrapText: true };
  });
  head.height = 22;
  for (const r of rows) {
    const row = ws.addRow(columns.map(([, get]) => { const v = get(r); return v === undefined ? null : v; }));
    row.alignment = { vertical: 'top', wrapText: false };
  }
  if (rows.length) ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + rows.length, column: columns.length } };
  return ws;
}

async function build(userId, { pii = false } = {}) {
  const d = await gather(userId);
  if (!d) return null;
  const u = d.user;
  const m = (v) => { const s = String(v || '').replace(/\D/g, '').slice(-10); return !s ? '' : pii ? `+91 ${s.slice(0, 5)} ${s.slice(5)}` : `•••••• ${s.slice(-4)}`; };
  const em = (v) => (!v ? '' : pii ? v : String(v).replace(/^(.).*(@.*)$/, '$1•••$2'));
  const ipOf = (v) => (!v ? '' : pii ? v : String(v).replace(/\d+$/, '•••'));
  const code = `GP-C-${String(u.id).padStart(6, '0')}`;
  const name = u.display_name || u.wa_profile_name || '-';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'GaadiPe admin'; wb.created = new Date();

  /* Summary */
  const ft = parse(d.firstVisit?.first_touch) || {};
  const paid = d.payments.filter((p) => p.status === 'paid');
  const secondsOnSite = d.sessions.reduce((a, s) => a + Number(s.seconds || 0), 0);
  const summary = [
    ['Customer', `${name} · ${code}`], ['Mobile', m(u.mobile)], ['Email', em(u.email)],
    ['Email confirmed', u.email_verified_at ? `Yes · ${when(u.email_verified_at)}` : 'No'],
    ['Joined', when(u.created_at)], ['Signed up on', u.signup_channel === 'web' ? 'Website' : 'WhatsApp'],
    ['Last seen', when(u.last_seen_at)], ['State (for GST)', u.state_code || ''],
    ['First came from', [ft.source, ft.campaign, ft.medium].filter(Boolean).join(' · ') || 'Not known'],
    ['First visit', when(d.firstVisit?.first_seen_at)], ['Landing page', ft.landing || ''],
    ['Tips & offers consent', u.promo_consent_at ? `Yes · ${when(u.promo_consent_at)}` : 'No'],
    ['Account', u.archived_at ? `Deactivated · ${when(u.archived_at)}` : u.is_paused ? 'Paused' : 'Active'],
    ['', ''],
    ['Vehicles checked', d.vehicles.length], ['Vehicle checks (all)', d.checks.length], ['Full reports', d.reports.length],
    ['Payments (paid)', paid.length], ['Paid in total (₹)', rs(paid.reduce((a, p) => a + Number(p.amount_paise || 0), 0))],
    ['Sign-ins', d.signIns.filter((s) => s.event === 'signed_in').length], ['Signed-in sessions', d.sessions.length],
    ['Time signed in on the website', secs(secondsOnSite)], ['Website visits', d.visits.length],
    ['', ''], ['Exported', `${when(new Date())} IST${pii ? '' : ' · personal details masked'}`],
  ];
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 32 }, { width: 60 }];
  ws.mergeCells('A1:B1');
  ws.getCell('A1').value = `GaadiPe · ${name} · ${code}`;
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } }; ws.getCell('A1').fill = fill(C.brand);
  ws.getCell('A1').alignment = { vertical: 'middle', indent: 1 }; ws.getRow(1).height = 30;
  summary.forEach(([k, v], i) => {
    const r = ws.getRow(i + 3); r.getCell(1).value = k; r.getCell(2).value = v;
    if (k) { r.getCell(1).font = { bold: true, color: { argb: C.body } }; r.getCell(1).fill = fill(C.brandSoft); }
  });

  /* Charts — the tables the charts are drawn from (A–J), the charts beside them. */
  const days = new Map();
  const start = new Date(Math.max(new Date(u.created_at).getTime(), Date.now() - 89 * 86400e3));
  for (let t = new Date(ymd(start)).getTime(); t <= Date.now(); t += 86400e3) days.set(new Date(t).toISOString().slice(0, 10), { checks: 0, signIns: 0, minutes: 0 });
  for (const c of d.checks) { const k = ymd(c.created_at); if (days.has(k)) days.get(k).checks += 1; }
  for (const s of d.signIns) if (s.event === 'signed_in') { const k = ymd(s.created_at); if (days.has(k)) days.get(k).signIns += 1; }
  for (const s of d.sessions) { const k = ymd(s.created_at); if (days.has(k)) days.get(k).minutes += Math.round(Number(s.seconds || 0) / 60); }
  const months = new Map();
  for (const p of paid) { const k = ymd(p.paid_at || p.created_at).slice(0, 7); months.set(k, (months.get(k) || 0) + Number(p.amount_paise || 0)); }
  const found = d.checks.filter((c) => parse(c.detail)?.found !== false).length;
  const cs = wb.addWorksheet('Charts', { views: [{ showGridLines: false }] });
  cs.columns = [{ width: 13 }, { width: 11 }, { width: 11 }, { width: 13 }, { width: 3 }, { width: 11 }, { width: 13 }, { width: 3 }, { width: 18 }, { width: 10 }];
  cs.getRow(1).values = ['Day', 'Checks', 'Sign-ins', 'Minutes on site', null, 'Month', 'Paid (₹)', null, 'Checks', 'Count'];
  cs.getRow(1).font = { bold: true }; cs.getRow(1).fill = fill(C.head);
  const dayRows = [...days.entries()];
  dayRows.forEach(([k, v], i) => { cs.getRow(i + 2).getCell(1).value = k.slice(5); cs.getRow(i + 2).getCell(2).value = v.checks; cs.getRow(i + 2).getCell(3).value = v.signIns; cs.getRow(i + 2).getCell(4).value = v.minutes; });
  const monthRows = [...months.entries()].sort();
  if (!monthRows.length) monthRows.push([ymd(new Date()).slice(0, 7), 0]);
  monthRows.forEach(([k, v], i) => { cs.getRow(i + 2).getCell(6).value = k; cs.getRow(i + 2).getCell(7).value = rs(v); });
  cs.getRow(2).getCell(9).value = 'Found'; cs.getRow(2).getCell(10).value = found;
  cs.getRow(3).getCell(9).value = 'Not found / failed'; cs.getRow(3).getCell(10).value = d.checks.length - found;
  const charts = {
    sheet: 'Charts',
    list: [
      { type: 'bar', title: 'Vehicle checks per day', cat: ['A', 2, 1 + dayRows.length], series: [['B', 'Checks', '0F766E']], data: dayRows.map(([k, v]) => [k.slice(5), v.checks]) },
      { type: 'bar', title: 'Sign-ins per day', cat: ['A', 2, 1 + dayRows.length], series: [['C', 'Sign-ins', 'E08700']], data: dayRows.map(([k, v]) => [k.slice(5), v.signIns]) },
      { type: 'line', title: 'Minutes signed in on the website, per day', cat: ['A', 2, 1 + dayRows.length], series: [['D', 'Minutes', '2563EB']], data: dayRows.map(([k, v]) => [k.slice(5), v.minutes]) },
      { type: 'bar', title: 'Paid per month (₹)', cat: ['F', 2, 1 + monthRows.length], series: [['G', 'Paid (₹)', '0A6C34']], data: monthRows.map(([k, v]) => [k, rs(v)]) },
      { type: 'pie', title: 'Checks: found against not found / failed', cat: ['I', 2, 3], series: [['J', 'Checks', '0F766E']], data: [['Found', found], ['Not found / failed', d.checks.length - found]] },
    ],
  };

  /* Vehicles */
  table(wb, 'Vehicles', `Vehicles checked by ${name}`, [
    ['Vehicle', (v) => v.reg_no, 14], ['Make', (v) => v.maker, 24], ['Model', (v) => v.model, 26], ['Fuel', (v) => v.fuel, 10],
    ['Class', (v) => v.vehicle_class, 20], ['RC status', (v) => v.rc_status, 12], ['Registered', (v) => day(v.reg_date), 13],
    ['Registration valid to', (v) => day(v.reg_upto), 14], ['Insurance to', (v) => day(v.insurance_upto), 13], ['PUC to', (v) => day(v.pucc_upto), 13],
    ['Fitness to', (v) => day(v.fitness_upto), 13], ['Tax to', (v) => day(v.tax_upto) || v.tax_upto || '', 13], ['Permit to', (v) => day(v.permit_upto), 13],
    ['Owner no.', (v) => v.owner_serial, 9], ['Financer / loan', (v) => v.financer, 20], ['Blacklist', (v) => v.blacklist_status, 14],
    ['First checked', (v) => when(v.first_checked_at), 22], ['Last checked', (v) => when(v.last_checked_at), 22], ['Times checked', (v) => v.check_count, 10],
    ['Full reports', (v) => v.reports, 9], ['Report valid to', (v) => day(v.report_until), 13], ['Monitored', (v) => (v.watched ? 'Yes' : 'No'), 10],
  ], d.vehicles);

  /* Checks */
  table(wb, 'Checks', 'Every vehicle check', [
    ['When', (c) => when(c.created_at), 24], ['Vehicle', (c) => parse(c.detail)?.reg_no, 14],
    ['Result', (c) => (parse(c.detail)?.found === false ? 'Not found / failed' : 'Found'), 16],
    ['Repeat', (c) => (c.kind === 'vehicle_check_repeat' ? 'Yes' : 'No'), 8],
    ['Channel', (c) => (parse(c.detail)?.channel === 'web' ? 'Website' : (parse(c.detail)?.channel || 'WhatsApp')), 10],
  ], d.checks);

  /* Reports */
  table(wb, 'Reports', 'Full reports', [
    ['Report', (r) => r.report_number, 20], ['Vehicle', (r) => r.reg_no, 14], ['Issued', (r) => when(r.created_at), 24],
    ['Valid to', (r) => when(r.valid_until), 24], ['Payment id', (r) => (r.payment_id ? `GP-T-${r.payment_id}` : 'Free'), 14], ['Channel', (r) => r.channel, 10],
  ], d.reports);

  /* Payments */
  table(wb, 'Payments', 'Payments and invoices', [
    ['Payment', (p) => `GP-T-${p.id}`, 12], ['Started', (p) => when(p.created_at), 24], ['Paid', (p) => when(p.paid_at), 24], ['Status', (p) => p.status, 10],
    ['Amount (₹)', (p) => rs(p.amount_paise), 11], ['Channel', (p) => (p.channel === 'web' ? 'Website' : p.channel), 10], ['Vehicle', (p) => p.reg_no, 14],
    ['Gateway', (p) => p.gateway, 10], ['Order id', (p) => p.order_id, 24], ['Gateway payment id', (p) => p.gateway_payment_id, 24],
    ['Invoice', (p) => p.invoice_number, 20], ['Invoice date', (p) => day(p.invoice_date), 13], ['Taxable (₹)', (p) => rs(p.base_paise), 11],
    ['CGST (₹)', (p) => rs(p.cgst_paise), 9], ['SGST (₹)', (p) => rs(p.sgst_paise), 9], ['IGST (₹)', (p) => rs(p.igst_paise), 9], ['Invoice total (₹)', (p) => rs(p.total_paise), 13],
  ], d.payments);

  /* Sign-ins */
  const EVENT = { code_requested: 'Code requested', code_refused: 'Code refused', sign_in_failed: 'Sign-in failed', signed_in: 'Signed in', signed_out: 'Signed out', session_expired: 'Session expired' };
  const consentText = (r) => {
    if (r.event !== 'signed_in') return '';
    if (!r.consent_at) return 'No agreement recorded';
    const c = parse(r.consent) || {};
    const v = Object.entries(c.versions || {}).map(([k, x]) => `${k} v${x}`).join(', ');
    return `Agreed ${when(r.consent_at)}${v ? ` (${v})` : ''}`;
  };
  table(wb, 'Sign-ins', 'Every sign-in step, with the device and the agreement', [
    ['When', (r) => when(r.created_at), 24], ['Step', (r) => EVENT[r.event] || r.event, 15], ['Outcome', (r) => r.outcome, 14],
    ['Terms / Privacy / Refund', consentText, 40], ['Mobile', (r) => m(r.mobile), 16], ['Session id', (r) => r.session_id, 10],
    ['IP', (r) => ipOf(r.ip), 16], ['City', (r) => r.city, 14], ['Region', (r) => r.region, 14], ['Country', (r) => r.country, 10],
    ['Device', (r) => [r.device_type, r.device_vendor, r.device_model].filter(Boolean).join(' · '), 22], ['OS', (r) => [r.os, r.os_version].filter(Boolean).join(' '), 14],
    ['Browser', (r) => [r.browser, r.browser_version].filter(Boolean).join(' '), 16], ['Screen', (r) => r.screen, 12], ['Time zone', (r) => r.timezone, 14],
    ['Languages', (r) => r.languages, 16], ['Network', (r) => r.connection, 12], ['Came from', (r) => r.referrer, 30], ['Page', (r) => r.page, 14],
    ['Device id', (r) => r.device_id, 40], ['User agent', (r) => r.user_agent, 80],
  ], d.signIns);

  /* Sessions */
  const STATE = { online: 'Online', idle: 'Signed in, idle', signed_out: 'Signed out', expired: 'Expired', deactivated: 'Deactivated' };
  table(wb, 'Sessions', 'Signed-in sessions — when, how long, how it ended', [
    ['Signed in', (s) => when(s.created_at), 24], ['Last active', (s) => when(s.last_used_at), 24], ['Ended', (s) => when(s.ended_at), 24],
    ['How it ended', (s) => STATE[s.state] || s.state, 16], ['Stayed', (s) => secs(s.seconds), 10], ['Seconds', (s) => Number(s.seconds || 0), 9],
    ['Requests', (s) => Number(s.request_count || 0), 9], ['Agreed to terms at', (s) => when(s.consent_at), 24],
    ['IP', (s) => ipOf(s.ip), 16], ['Last IP', (s) => ipOf(s.last_ip), 16],
    ['Device', (s) => device.describe(device.parseUA(s.user_agent)), 30], ['Device id', (s) => s.device_id, 40], ['User agent', (s) => s.user_agent, 80],
  ], d.sessions);

  /* Visits */
  table(wb, 'Visits', 'Website visits', [
    ['Started', (v) => when(v.started_at), 24], ['Last seen', (v) => when(v.last_seen_at), 24],
    ['Duration', (v) => secs((new Date(v.last_seen_at) - new Date(v.started_at)) / 1000), 10], ['Source', (v) => v.source, 12], ['Campaign', (v) => v.campaign, 18],
    ['Landing', (v) => v.landing, 16], ['Pages', (v) => v.pages, 7], ['Taps', (v) => v.interactions, 7], ['Last step', (v) => v.step, 14], ['Last action', (v) => v.action, 30],
    ['Device', (v) => { const x = parse(v.device) || {}; return [x.device_type, x.os, x.browser].filter(Boolean).join(' · '); }, 26],
    ['Place', (v) => { const x = parse(v.place) || {}; return [x.city, x.region, x.country].filter(Boolean).join(', '); }, 22], ['Visit id', (v) => v.session_id, 26],
  ], d.visits);

  /* Agreements */
  table(wb, 'Agreements', 'Terms, policies and consents — every one, with its time', [
    ['When', (a) => when(a.created_at), 24], ['What', (a) => a.kind.replace(/_/g, ' '), 26],
    ['Documents', (a) => (parse(a.detail)?.documents || []).join(', '), 24],
    ['Versions', (a) => Object.entries(parse(a.detail)?.versions || {}).map(([k, x]) => `${k} v${x}`).join(', '), 30],
    ['Channel', (a) => parse(a.detail)?.channel, 10], ['IP', (a) => ipOf(parse(a.detail)?.ip), 16], ['Wording', (a) => parse(a.detail)?.text || parse(a.detail)?.consent_text || '', 60],
  ], d.agreements);

  /* Activity */
  table(wb, 'Activity', 'The event trail, newest first', [
    ['When', (e) => when(e.occurred_at), 24], ['Event', (e) => String(e.name || '').replace(/_/g, ' '), 26], ['Channel', (e) => e.channel, 10],
    ['Vehicle', (e) => e.reg_no, 14], ['Amount (₹)', (e) => rs(e.amount_paise), 10], ['Status', (e) => e.status, 10], ['Page', (e) => e.page, 16], ['Source', (e) => e.source, 12],
    ['Detail', (e) => { const x = parse(e.metadata); return x ? JSON.stringify(x).slice(0, 300) : ''; }, 60],
  ], d.activity);

  const buf = await wb.xlsx.writeBuffer();
  const withCharts = await addCharts(Buffer.from(buf), wb, charts);
  return { buffer: withCharts, fileName: `GaadiPe-${code}-${ymd(new Date())}.xlsx`, user: { id: String(u.id), mobile: u.mobile } };
}

/* ────────────────────────── real Excel charts ────────────────────────── */

/*
 * EXCELJS CANNOT DRAW CHARTS, so they are added to the finished file: a
 * chartN.xml per chart (DrawingML, with the values cached so every viewer
 * shows them at once), one drawing on the Charts sheet holding them all, and
 * the relationships and content types that tie them in. Each chart reads its
 * cells on the Charts sheet, so it stays a normal, editable Excel chart.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NS_C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function chartXml(sheet, ch) {
  const ref = (col, a, b) => `'${sheet}'!$${col}$${a}:$${col}$${b}`;
  const [catCol, a, b] = ch.cat;
  const strCache = `<c:strCache><c:ptCount val="${ch.data.length}"/>${ch.data.map(([k], i) => `<c:pt idx="${i}"><c:v>${esc(k)}</c:v></c:pt>`).join('')}</c:strCache>`;
  const [valCol, name, colour] = ch.series[0];
  const numCache = `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${ch.data.length}"/>${ch.data.map(([, v], i) => `<c:pt idx="${i}"><c:v>${Number(v) || 0}</c:v></c:pt>`).join('')}</c:numCache>`;
  const PIE = ['0F766E', 'E08700', 'B42318', '2563EB'];
  const ser = `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${esc(name)}</c:v></c:tx>`
    + (ch.type === 'pie'
      ? ch.data.map((_, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${PIE[i % PIE.length]}"/></a:solidFill></c:spPr></c:dPt>`).join('')
      : ch.type === 'line'
        ? `<c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="4"/></c:marker>`
        : `<c:spPr><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>`)
    + (ch.type === 'pie' ? '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls>' : '')
    + `<c:cat><c:strRef><c:f>${ref(catCol, a, b)}</c:f>${strCache}</c:strRef></c:cat>`
    + `<c:val><c:numRef><c:f>${ref(valCol, a, b)}</c:f>${numCache}</c:numRef></c:val>`
    + (ch.type === 'line' ? '<c:smooth val="0"/>' : '') + '</c:ser>';
  const axes = '<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
    + '<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E3ECEA"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="5001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>';
  const plot = ch.type === 'pie'
    ? `<c:pieChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/></c:pieChart>`
    : ch.type === 'line'
      ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/><c:axId val="5001"/><c:axId val="5002"/></c:lineChart>${axes}`
      : `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${ser}<c:gapWidth val="60"/><c:axId val="5001"/><c:axId val="5002"/></c:barChart>${axes}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace ${NS_C}><c:roundedCorners val="0"/><c:chart>`
    + `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="en-IN" sz="1200" b="1"/><a:t>${esc(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
    + `<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea>`
    + `<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

async function addCharts(buffer, wb, { sheet, list }) {
  const zip = await JSZip.loadAsync(buffer);
  const sheetIndex = wb.worksheets.findIndex((w) => w.name === sheet) + 1;
  const sheetPath = `xl/worksheets/sheet${sheetIndex}.xml`;
  if (!zip.file(sheetPath)) return buffer;
  const first = 1;   // no other drawings or charts exist in this workbook
  // The charts, two to a row of ~18 rows each, to the right of the tables (column L onwards).
  const anchors = list.map((ch, i) => {
    const col = 11 + (i % 2) * 9; const row = 1 + Math.floor(i / 2) * 19;
    zip.file(`xl/charts/chart${first + i}.xml`, chartXml(sheet, ch));
    return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
      + `<xdr:to><xdr:col>${col + 8}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 18}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
      + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
      + '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
      + `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${i + 1}"/>`
      + '</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>';
  });
  zip.file('xl/drawings/drawing1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + anchors.join('') + '</xdr:wsDr>');
  zip.file('xl/drawings/_rels/drawing1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${first + i}.xml"/>`).join('')
    + '</Relationships>');

  // The Charts sheet points at the drawing.
  const relsPath = `xl/worksheets/_rels/sheet${sheetIndex}.xml.rels`;
  const relsXml = zip.file(relsPath) ? await zip.file(relsPath).async('string')
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  zip.file(relsPath, relsXml.replace('</Relationships>',
    '<Relationship Id="rIdGpCharts" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>'));
  let sx = await zip.file(sheetPath).async('string');
  if (!/xmlns:r=/.test(sx.slice(0, 600))) sx = sx.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  // <drawing> goes after pageMargins / pageSetup / headerFooter and before tableParts / extLst.
  const at = ['<legacyDrawing', '<tableParts', '<extLst', '</worksheet>'].map((t) => sx.indexOf(t)).filter((i) => i >= 0).sort((x, y) => x - y)[0];
  sx = `${sx.slice(0, at)}<drawing r:id="rIdGpCharts"/>${sx.slice(at)}`;
  zip.file(sheetPath, sx);

  let ct = await zip.file('[Content_Types].xml').async('string');
  const overrides = list.map((_, i) => `<Override PartName="/xl/charts/chart${first + i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('')
    + '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>';
  ct = ct.replace('</Types>', `${overrides}</Types>`);
  zip.file('[Content_Types].xml', ct);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { build, gather, _test: { chartXml, addCharts } };
