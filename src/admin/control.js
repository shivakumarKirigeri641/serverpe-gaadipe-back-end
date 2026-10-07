/**
 * src/admin/control.js — THE CONTROL ROOM (user, 2026-10-07; spec §8–11, §14–15,
 * §25, §30–31, §39, §54, §62, §91–92, §103, §105). Read-only.
 *
 *   sessions(q)        website visits, newest first, with their status now
 *   session(id)        one visit: who, where from, its whole timeline — before AND
 *                      after signing in, as one journey — pages, taps, checks,
 *                      payments, reports, and the API calls behind its vehicles
 *   customer(id)       one customer: live now?, totals, behaviour, journey stages,
 *                      sessions, devices, vehicles, payments, reports, API trace
 *   search(q)          any GP-… id, a mobile, a vehicle, a report / payment / order
 *
 * Everything is joined by the ids the rest of GaadiPe already keeps: the visit's
 * session id (web_sessions, events), the browser's visitor id, the customer's
 * user id, the vehicle number, the payment id.
 */

const db = require('../db');
const settings = require('../util/settings');
const { statusOf } = require('../site/presence');

const n = (v) => Number(v) || 0;
const plateOf = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function windows() {
  return { idleS: await settings.num('web_idle_seconds', 60), offlineS: await settings.num('web_offline_seconds', 75) };
}

/* ── sessions ── */
async function sessions({ range = 'today', status = '', q = '', userId = null, limit = 100, offset = 0 } = {}) {
  const days = { today: 0, '7d': 6, '30d': 29 }[range] ?? 0;
  const term = String(q || '').trim().replace(/[%_]/g, '');
  const { rows } = await db.query(
    `SELECT w.*, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
            (SELECT count(*) FROM payments p WHERE p.user_id = w.user_id AND p.status = 'paid'
                AND p.paid_at BETWEEN w.started_at AND w.last_seen_at + interval '30 minutes') AS paid_in_visit,
            count(*) OVER () AS total_rows
       FROM web_sessions w LEFT JOIN users u ON u.id = w.user_id
      WHERE w.started_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - make_interval(days => $1::int)) AT TIME ZONE 'Asia/Kolkata'
        AND ($2::bigint IS NULL OR w.user_id = $2)
        AND ($3 = '' OR u.mobile ILIKE '%' || $3 || '%' OR w.session_id ILIKE '%' || lower($3) || '%' OR w.visitor_id ILIKE '%' || lower($3) || '%'
             OR coalesce(u.display_name, u.wa_profile_name, '') ILIKE '%' || $3 || '%')
      ORDER BY w.last_seen_at DESC LIMIT $4 OFFSET $5`,
    [days, userId, term, Math.min(300, Number(limit) || 100), Number(offset) || 0]);
  const w = await windows(); const now = Date.now();
  let list = rows.map(({ total_rows, ...r }) => ({ ...r, user_id: r.user_id ? String(r.user_id) : null, paid_in_visit: n(r.paid_in_visit),
    status: statusOf(r, { ...w, now }), seconds: Math.round((new Date(r.ended_at || r.last_seen_at) - new Date(r.started_at)) / 1000) }));
  if (status) list = list.filter((r) => r.status === status);
  return { total: rows[0] ? n(rows[0].total_rows) : 0, rows: list };
}

/* What a visit reached: the journey stages (spec §21, §54). */
function stagesOf(tl) {
  const has = (f) => tl.some(f);
  return [
    ['arrived', 'Arrived', true],
    ['searched', 'Searched a vehicle', has((e) => e.kind === 'check' || e.kind === 'chat' || (e.kind === 'interaction' && e.ikind === 'search'))],
    ['signed_in', 'Signed in', has((e) => e.kind === 'signin' && e.name === 'signed_in')],
    ['viewed', 'Saw a vehicle', has((e) => (e.kind === 'check' || e.kind === 'chat') && e.ok)],
    ['pay_opened', 'Opened the ₹19 payment', has((e) => e.name === 'payment_page_viewed' || e.name === 'payment_started')],
    ['paid', 'Paid', has((e) => e.name === 'payment_success')],
    ['report', 'Got the report', has((e) => e.name === 'report_generated' || e.name === 'full_view')],
  ].map(([key, label, done]) => ({ key, label, done }));
}

/**
 * One visit's whole story, oldest first. The site's own events carry the visit's
 * session id (before and after signing in — one journey); what the server did for
 * the signed-in customer during the visit (sign-in, checks, payments, reports) is
 * joined by the customer and the visit's time window.
 */
async function timelineFor({ sessionId, userId, from, to }) {
  const [ev, si, el, pay, rep] = await Promise.all([
    db.query(`SELECT id, occurred_at AS at, name, page, reg_no, source, status, metadata->>'label' AS label, metadata->>'kind' AS ikind,
                     metadata->>'section' AS section, metadata->>'step' AS step, metadata->>'referrer' AS referrer
                FROM events WHERE session_id = $1 ORDER BY occurred_at LIMIT 1000`, [sessionId]),
    userId ? db.query(`SELECT id, created_at AS at, event, device_model, browser, city FROM site_sign_ins
                         WHERE (user_id = $1 OR mobile = (SELECT right(mobile, 10) FROM users WHERE id = $1)) AND created_at BETWEEN $2 AND $3 ORDER BY created_at`, [userId, from, to])
      : { rows: [] },
    userId ? db.query(`SELECT id, created_at AS at, kind, detail->>'reg_no' AS reg_no, (detail->>'found')::boolean AS found, detail->>'channel' AS ch
                         FROM event_log WHERE user_id = $1 AND created_at BETWEEN $2 AND $3
                          AND kind IN ('vehicle_check', 'vehicle_check_repeat', 'full_view') ORDER BY created_at`, [userId, from, to])
      : { rows: [] },
    userId ? db.query(`SELECT id, created_at, paid_at, status, amount_paise, coalesce(raw->>'reg_no', (SELECT reg_no FROM vehicles WHERE id = nullif(raw->>'vehicle_id', '')::bigint)) AS reg_no, payment_id AS razorpay_payment_id, order_id
                         FROM payments WHERE user_id = $1 AND created_at BETWEEN $2 AND $3 ORDER BY created_at`, [userId, from, to])
      : { rows: [] },
    userId ? db.query(`SELECT id, created_at AS at, report_number, reg_no FROM vehicle_reports WHERE user_id = $1 AND created_at BETWEEN $2 AND $3`, [userId, from, to])
      : { rows: [] },
  ]);
  const tl = [];
  for (const e of ev.rows) {
    tl.push({ key: `ev${e.id}`, at: e.at, kind: e.name === 'interaction' ? 'interaction' : e.name === 'page_view' ? 'page' : e.name === 'session_started' ? 'visit' : 'event',
      name: e.name, page: e.page, reg_no: e.reg_no, label: e.label, ikind: e.ikind, section: e.section, step: e.step, source: e.source, referrer: e.referrer,
      ok: e.ikind !== 'error' && e.status !== 'failed' });
  }
  for (const s of si.rows) tl.push({ key: `si${s.id}`, at: s.at, kind: 'signin', name: s.event, label: [s.device_model, s.browser, s.city].filter(Boolean).join(' · '), ok: !/fail|refus/.test(s.event) });
  for (const x of el.rows) tl.push({ key: `el${x.id}`, at: x.at, kind: 'check', name: x.kind, reg_no: x.reg_no, ok: x.found !== false, label: x.ch === 'web' ? 'website' : '' });
  for (const p of pay.rows) {
    tl.push({ key: `ps${p.id}`, at: p.created_at, kind: 'payment', name: 'payment_started', reg_no: p.reg_no, amount_paise: p.amount_paise, payment_id: String(p.id), ok: true });
    if (p.paid_at) tl.push({ key: `pp${p.id}`, at: p.paid_at, kind: 'payment', name: 'payment_success', reg_no: p.reg_no, amount_paise: p.amount_paise, payment_id: String(p.id), ok: true, ref: p.razorpay_payment_id });
    else if (p.status === 'failed') tl.push({ key: `pf${p.id}`, at: p.created_at, kind: 'payment', name: 'payment_failed', reg_no: p.reg_no, amount_paise: p.amount_paise, payment_id: String(p.id), ok: false });
  }
  for (const r of rep.rows) tl.push({ key: `rp${r.id}`, at: r.at, kind: 'report', name: 'report_generated', reg_no: r.reg_no, label: r.report_number, ok: true });
  tl.sort((a, b) => new Date(a.at) - new Date(b.at));
  return { tl, payments: pay.rows, reports: rep.rows };
}

/* The API calls behind a set of vehicles in a time window — the trace (spec §25). */
async function apiTrace(regs, from, to) {
  if (!regs.length) return [];
  const { rows } = await db.query(
    `SELECT id, created_at, dataset, reg_no, ok, cache_hit, outcome, http_status, duration_ms, cost_paise, coalesce(error_message, error_code) AS err
       FROM api_calls WHERE reg_no = ANY($1) AND created_at BETWEEN $2 AND $3 ORDER BY created_at LIMIT 200`, [regs, from, to]);
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

async function session(id) {
  const sid = String(id || '').slice(0, 64);
  const w = await db.one(
    `SELECT w.*, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.email,
            (SELECT count(*) FROM web_sessions o WHERE o.visitor_id = w.visitor_id AND o.started_at < w.started_at) AS earlier,
            v.first_touch, v.first_seen_at AS browser_first_seen
       FROM web_sessions w LEFT JOIN users u ON u.id = w.user_id LEFT JOIN visitors v ON v.visitor_id = w.visitor_id
      WHERE w.session_id = $1`, [sid]);
  if (!w) return { session: null };
  const from = new Date(new Date(w.started_at).getTime() - 60000);
  const to = new Date(new Date(w.ended_at || w.last_seen_at).getTime() + 30 * 60000);
  const { tl, payments, reports } = await timelineFor({ sessionId: sid, userId: w.user_id, from, to });
  const regs = [...new Set(tl.map((e) => plateOf(e.reg_no)).filter((r) => r.length >= 5))];
  const pages = {};
  for (const e of tl.filter((x) => x.kind === 'page' || x.kind === 'visit')) pages[e.page] = (pages[e.page] || 0) + 1;
  const linkedAt = tl.find((e) => e.kind === 'signin' && e.name === 'signed_in')?.at || null;
  const st = statusOf(w, { ...(await windows()), now: Date.now() });
  return {
    session: { ...w, user_id: w.user_id ? String(w.user_id) : null, status: st, returning: n(w.earlier) > 0, earlier: n(w.earlier),
      seconds: Math.round((new Date(w.ended_at || w.last_seen_at) - new Date(w.started_at)) / 1000), linked_at: linkedAt },
    stages: stagesOf(tl),
    timeline: tl,
    pages: Object.entries(pages).map(([page, views]) => ({ page, views })).sort((a, b) => b.views - a.views),
    vehicles: regs,
    payments: payments.map((p) => ({ ...p, id: String(p.id) })),
    reports: reports.map((r) => ({ ...r, id: String(r.id) })),
    api: await apiTrace(regs, from, to),
    errors: tl.filter((e) => e.ok === false),
  };
}

async function customer(id) {
  const uid = String(id || '').replace(/\D/g, '');
  if (!uid) return { customer: null };
  const u = await db.one(
    `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.email, u.email_verified_at, u.email_unsubscribed_at,
            u.created_at, u.deactivated_at, u.is_paused, u.preferred_language, u.promo_consent_at,
            (SELECT count(*) FROM web_sessions WHERE user_id = u.id) AS sessions,
            (SELECT count(*) FROM user_vehicles WHERE user_id = u.id) AS vehicles,
            (SELECT count(*) FROM watches WHERE user_id = u.id AND is_active) AS watching,
            (SELECT count(*) FROM vehicle_reports WHERE user_id = u.id) AS reports,
            (SELECT count(*) FROM payments WHERE user_id = u.id AND status = 'paid') AS purchases,
            (SELECT count(*) FROM payments WHERE user_id = u.id AND status IN ('failed', 'created')) AS unpaid_attempts,
            (SELECT coalesce(sum(amount_paise), 0) FROM payments WHERE user_id = u.id AND status = 'paid') AS revenue_paise,
            (SELECT count(*) FROM event_log WHERE user_id = u.id AND kind IN ('vehicle_check', 'vehicle_check_repeat')) AS searches,
            (SELECT count(*) FROM customer_push_subscriptions WHERE user_id = u.id) AS push_devices,
            (SELECT count(*) FROM whatsapp_messages m WHERE right(regexp_replace(m.mobile, '\\D', '', 'g'), 10) = right(regexp_replace(u.mobile, '\\D', '', 'g'), 10)) AS wa_messages,
            (SELECT min(started_at) FROM web_sessions WHERE user_id = u.id) AS first_visit,
            (SELECT max(last_seen_at) FROM web_sessions WHERE user_id = u.id) AS last_visit,
            (SELECT avg(extract(epoch FROM (coalesce(ended_at, last_seen_at) - started_at)))::int FROM web_sessions WHERE user_id = u.id) AS avg_seconds,
            (SELECT coalesce(sum(pages), 0) FROM web_sessions WHERE user_id = u.id) AS pages
       FROM users u WHERE u.id = $1`, [uid]);
  if (!u) return { customer: null };
  const w = await windows(); const now = Date.now();
  const { rows: sess } = await db.query(
    `SELECT * FROM web_sessions WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT 60`, [uid]);
  const sessionsList = sess.map((r) => ({ ...r, user_id: String(uid), status: statusOf(r, { ...w, now }),
    seconds: Math.round((new Date(r.ended_at || r.last_seen_at) - new Date(r.started_at)) / 1000) }));
  const live = sessionsList.filter((s) => !['OFFLINE', 'ENDED', 'TERMINATED'].includes(s.status));
  const { rows: devices } = await db.query(
    `SELECT v.visitor_id, v.first_seen_at, v.last_seen_at, v.device, v.place, coalesce(nullif(v.first_touch->>'source', ''), 'direct') AS source,
            (SELECT count(*) FROM web_sessions s WHERE s.visitor_id = v.visitor_id) AS sessions
       FROM visitors v WHERE v.user_id = $1 ORDER BY v.last_seen_at DESC LIMIT 20`, [uid]);
  const { rows: signIns } = await db.query(
    `SELECT device_id, max(created_at) AS last_at, min(created_at) AS first_at, count(*) FILTER (WHERE event = 'signed_in') AS sign_ins,
            max(device_model) AS model, max(browser) AS browser, max(os) AS os, max(city) AS city
       FROM site_sign_ins WHERE user_id = $1 GROUP BY device_id ORDER BY 2 DESC LIMIT 20`, [uid]);
  const { rows: openSites } = await db.query(
    `SELECT id, device_id, ip, user_agent, created_at, last_used_at FROM site_sessions WHERE user_id = $1 AND ended_at IS NULL ORDER BY last_used_at DESC NULLS LAST LIMIT 20`, [uid]);
  const { rows: vehicles } = await db.query(
    `SELECT v.reg_no, v.maker, v.model, uv.last_checked_at,
            EXISTS (SELECT 1 FROM vehicle_reports r WHERE r.user_id = $1 AND r.reg_no = v.reg_no) AS has_report,
            EXISTS (SELECT 1 FROM watches x WHERE x.user_id = $1 AND x.vehicle_id = v.id AND x.is_active) AS watched
       FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id WHERE uv.user_id = $1 ORDER BY uv.last_checked_at DESC NULLS LAST LIMIT 50`, [uid]);
  const { rows: payments } = await db.query(
    `SELECT id, created_at, paid_at, status, amount_paise, coalesce(raw->>'reg_no', (SELECT reg_no FROM vehicles WHERE id = nullif(raw->>'vehicle_id', '')::bigint)) AS reg_no, raw->>'channel' AS channel, payment_id AS razorpay_payment_id
       FROM payments WHERE user_id = $1 ORDER BY id DESC LIMIT 50`, [uid]);
  const { rows: reports } = await db.query(
    `SELECT id, created_at, report_number, reg_no, valid_until FROM vehicle_reports WHERE user_id = $1 ORDER BY id DESC LIMIT 50`, [uid]);
  // The newest visit's whole story, for the control room's live column.
  const latest = sessionsList[0] ? await session(sessionsList[0].session_id) : null;
  const regs = vehicles.map((v) => v.reg_no).slice(0, 20);
  const api = await apiTrace(regs, new Date(Date.now() - 30 * 86400e3), new Date());
  const allTl = latest?.timeline || [];
  return {
    customer: { ...u, id: String(u.id), ...Object.fromEntries(['sessions', 'vehicles', 'watching', 'reports', 'purchases', 'unpaid_attempts', 'revenue_paise',
      'searches', 'push_devices', 'wa_messages', 'avg_seconds', 'pages'].map((k) => [k, n(u[k])])),
      conversion_pct: n(u.searches) ? Math.round((100 * n(u.purchases)) / n(u.searches)) : null },
    live: live[0] || null,
    sessions: sessionsList,
    devices: devices.map((d) => ({ ...d, sessions: n(d.sessions) })),
    sign_in_devices: signIns.map((d) => ({ ...d, sign_ins: n(d.sign_ins) })),
    open_sign_ins: openSites.map((s) => ({ ...s, id: String(s.id) })),
    vehicles, payments: payments.map((p) => ({ ...p, id: String(p.id) })), reports: reports.map((r) => ({ ...r, id: String(r.id) })),
    latest: latest ? { session_id: latest.session.session_id, stages: latest.stages, timeline: allTl.slice(-200) } : null,
    api: api.slice(-60),
  };
}

/* ── search everything (spec §31, §103) ── */
async function search(q) {
  const t = String(q || '').trim();
  const out = { q: t, groups: {} };
  if (t.length < 2) return out;
  const up = t.toUpperCase();
  const ids = [];
  let m;
  if ((m = /^GP-C-0*(\d+)$/.exec(up))) {
    const u = await db.one(`SELECT id, mobile, coalesce(display_name, wa_profile_name) AS name FROM users WHERE id = $1`, [m[1]]);
    if (u) ids.push({ type: 'Customer', id: String(u.id), label: `GP-C-${String(u.id).padStart(6, '0')} · ${u.name || 'Customer'}`, detail: u.mobile, to: `/customers/${u.id}` });
  }
  if ((m = /^GP-S-(?:\d{8}-)?([A-Z0-9]{4,})$/.exec(up))) {
    const { rows } = await db.query(`SELECT session_id, started_at, user_id FROM web_sessions WHERE upper(session_id) LIKE 'S\\_' || $1 || '%' ORDER BY started_at DESC LIMIT 5`, [m[1]]);
    for (const s of rows) ids.push({ type: 'Session', id: s.session_id, label: `Visit ${s.session_id}`, detail: s.started_at, to: `/sessions/${encodeURIComponent(s.session_id)}` });
  }
  if ((m = /^GP-D-([A-Z0-9]{4,})$/.exec(up))) {
    const { rows } = await db.query(`SELECT visitor_id, user_id, last_seen_at FROM visitors WHERE upper(visitor_id) LIKE 'V\\_' || $1 || '%' LIMIT 5`, [m[1]]);
    for (const v of rows) ids.push({ type: 'Device', id: v.visitor_id, label: `Browser ${v.visitor_id}`, detail: v.user_id ? `customer GP-C-${String(v.user_id).padStart(6, '0')}` : 'not signed in', to: v.user_id ? `/customers/${v.user_id}` : `/visitors?q=${v.visitor_id}` });
  }
  if ((m = /^GP-T-(\d+)$/.exec(up)) || /^(PAY|ORDER)_[A-Z0-9]+$/.test(up)) {
    const p = await db.one(`SELECT id, user_id, amount_paise, status FROM payments WHERE id::text = $1 OR upper(payment_id) = $2 OR upper(order_id) = $2`, [m ? m[1] : '-', up]);
    if (p) ids.push({ type: 'Payment', id: String(p.id), label: `GP-T-${p.id} · ₹${Math.round(n(p.amount_paise) / 100)} · ${p.status}`, detail: p.user_id ? `customer GP-C-${String(p.user_id).padStart(6, '0')}` : '', to: p.user_id ? `/customers/${p.user_id}` : '/payments' });
  }
  if (/^s_[a-z0-9]{8,}$/i.test(t) || /^v_[a-z0-9]{8,}$/i.test(t)) {
    const s = await db.one(`SELECT session_id FROM web_sessions WHERE session_id = $1 OR visitor_id = $1 ORDER BY last_seen_at DESC LIMIT 1`, [t.toLowerCase()]);
    if (s) ids.push({ type: 'Session', id: s.session_id, label: `Visit ${s.session_id}`, detail: '', to: `/sessions/${encodeURIComponent(s.session_id)}` });
  }
  out.groups.ids = ids;
  const base = await require('./search').search(t, { limit: 8 }).catch(() => ({ groups: {} }));
  const g = base.groups || {};
  out.groups.customers = (g.customers || []).map((c) => ({ ...c, to: `/customers/${c.id}` }));
  out.groups.vehicles = (g.vehicles || []).map((v) => ({ ...v, to: `/vehicles/${v.reg_no}` }));
  out.groups.reports = (g.reports || []).map((r) => ({ ...r, to: r.user_id ? `/customers/${r.user_id}` : '/reports' }));
  out.groups.payments = (g.payments || []).map((p) => ({ ...p, to: p.user_id ? `/customers/${p.user_id}` : '/payments' }));
  out.groups.events = (g.events || []).map((e) => ({ ...e, to: '/log' }));
  const term = t.replace(/[%_]/g, '');
  if (term.length >= 4) {
    const { rows } = await db.query(
      `SELECT w.session_id, w.started_at, w.user_id, u.mobile FROM web_sessions w LEFT JOIN users u ON u.id = w.user_id
        WHERE u.mobile LIKE '%' || $1 OR w.session_id ILIKE '%' || $1 || '%' ORDER BY w.last_seen_at DESC LIMIT 6`, [term]);
    out.groups.sessions = rows.map((s) => ({ ...s, id: s.session_id, to: `/sessions/${encodeURIComponent(s.session_id)}` }));
  }
  return out;
}

module.exports = { sessions, session, customer, search, stagesOf };
