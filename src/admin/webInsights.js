/**
 * src/admin/webInsights.js — WHAT THE NUMBERS SAY (user, 2026-10-07; spec §28,
 * §33–35, §55, §116–122, §16). Read-only, computed from what GaadiPe records —
 * nothing guessed, and every label says it is a behavioural signal, not a fact
 * about the person.
 *
 *   leads({ days })           customers scored by what they did (weights in the
 *                             web_lead_scoring setting) → Cold / Warm / Hot / Very hot
 *   stuck({ seconds })        on the site now, no action for that long, by step
 *   abandoned({ range })      visits that stopped at search, the code, the report
 *                             or the payment, with what they could have paid
 *   insights({ range })       plain sentences from the figures: what changed, where
 *                             people stop, which source and device pay best
 *   breakdown({ range })      devices, browsers, systems, places, pages, clicks, forms
 *   vehicle(reg)              one vehicle: details, who checked it, reports, API calls
 */

const db = require('../db');
const settings = require('../util/settings');
const { statusOf } = require('../site/presence');

const n = (v) => Number(v) || 0;
const FROM = (days) => `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - make_interval(days => ${Number(days) || 0})) AT TIME ZONE 'Asia/Kolkata'`;
const DAYS = { today: 0, '7d': 6, '30d': 29 };
const REPORT_PAISE = async () => (await require('../pay/billing').reportPlan().catch(() => null))?.price_paise || 1900;

async function weights() {
  const def = { landing: 1, vehicle_search: 5, vehicle_details: 5, report_cta: 10, payment_page: 20, payment_failed: 10, payment_success: 50, returning: 5, signed_in: 5, bands: { warm: 11, hot: 31, very_hot: 61 }, days: 7 };
  try { return { ...def, ...JSON.parse(await settings.get('web_lead_scoring', '{}') || '{}') }; } catch { return def; }
}
const bandOf = (score, b) => (score >= b.very_hot ? 'very_hot' : score >= b.hot ? 'hot' : score >= b.warm ? 'warm' : 'cold');
const INTENT = { cold: 'Low intent', warm: 'Medium intent', hot: 'High intent', very_hot: 'Very high intent' };

/* ── leads (spec §120–121) ── */
async function leads({ days = null, band = '' } = {}) {
  const W = await weights();
  const d = Number(days) || W.days || 7;
  const { rows } = await db.query(
    `WITH people AS (
       SELECT DISTINCT w.user_id FROM web_sessions w WHERE w.user_id IS NOT NULL AND w.started_at > now() - make_interval(days => $1)),
     f AS (
       SELECT p.user_id,
              (SELECT count(*) FROM web_sessions s WHERE s.user_id = p.user_id AND s.started_at > now() - make_interval(days => $1)) AS visits,
              (SELECT count(*) FROM web_sessions s WHERE s.user_id = p.user_id) AS visits_all,
              (SELECT count(*) FROM events e JOIN web_sessions s ON s.session_id = e.session_id
                WHERE s.user_id = p.user_id AND e.name = 'interaction' AND e.metadata->>'kind' = 'search' AND e.occurred_at > now() - make_interval(days => $1)) AS searches,
              (SELECT count(*) FROM events e JOIN web_sessions s ON s.session_id = e.session_id
                WHERE s.user_id = p.user_id AND e.name = 'interaction' AND e.metadata->>'kind' = 'view' AND e.occurred_at > now() - make_interval(days => $1)) AS views,
              (SELECT count(*) FROM events e JOIN web_sessions s ON s.session_id = e.session_id
                WHERE s.user_id = p.user_id AND e.name = 'interaction' AND (e.metadata->>'label' ILIKE '%full report%' OR e.metadata->>'step' = 'paying')
                  AND e.occurred_at > now() - make_interval(days => $1)) AS cta,
              (SELECT count(*) FROM event_log l WHERE l.user_id = p.user_id AND l.kind IN ('vehicle_check', 'vehicle_check_repeat') AND l.created_at > now() - make_interval(days => $1)) AS checks,
              (SELECT count(*) FROM payments x WHERE x.user_id = p.user_id AND x.created_at > now() - make_interval(days => $1)) AS pay_started,
              (SELECT count(*) FROM payments x WHERE x.user_id = p.user_id AND x.status = 'failed' AND x.created_at > now() - make_interval(days => $1)) AS pay_failed,
              (SELECT count(*) FROM payments x WHERE x.user_id = p.user_id AND x.status = 'paid' AND x.paid_at > now() - make_interval(days => $1)) AS paid,
              (SELECT max(last_seen_at) FROM web_sessions s WHERE s.user_id = p.user_id) AS last_seen
         FROM people p)
     SELECT f.*, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
            (SELECT coalesce(nullif(v.first_touch->>'source', ''), 'direct') FROM visitors v WHERE v.user_id = f.user_id ORDER BY v.first_seen_at LIMIT 1) AS source
       FROM f JOIN users u ON u.id = f.user_id`, [d]);
  const out = rows.map((r) => {
    const x = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, ['mobile', 'name', 'source', 'last_seen'].includes(k) ? v : n(v)]));
    const parts = [
      ['Visited', x.visits ? W.landing : 0], ['Searched a vehicle', Math.min(3, x.searches + x.checks) * W.vehicle_search],
      ['Saw vehicle details', Math.min(3, x.views) * W.vehicle_details], ['Tapped Full report', x.cta ? W.report_cta : 0],
      ['Opened the payment', x.pay_started ? W.payment_page : 0], ['A payment failed', x.pay_failed ? W.payment_failed : 0],
      ['Paid', x.paid ? W.payment_success : 0], ['Came back', x.visits_all > 1 ? W.returning : 0], ['Signed in', W.signed_in],
    ].filter(([, p]) => p);
    const score = parts.reduce((s, [, p]) => s + p, 0);
    const b = bandOf(score, W.bands);
    return { ...x, user_id: String(r.user_id), score, band: b, intent: INTENT[b], why: parts.map(([l, p]) => `${l} +${p}`) };
  }).filter((x) => !band || x.band === band).sort((a, b) => b.score - a.score);
  return { days: d, weights: W, rows: out.slice(0, 300),
    counts: ['very_hot', 'hot', 'warm', 'cold'].reduce((c, k) => ({ ...c, [k]: out.filter((x) => x.band === k).length }), {}) };
}

/* ── stuck now (spec §28) ── */
async function stuck({ seconds = 60 } = {}) {
  const s = Math.max(15, Math.min(3600, Number(seconds) || 60));
  const { rows } = await db.query(
    `SELECT w.*, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name FROM web_sessions w LEFT JOIN users u ON u.id = w.user_id
      WHERE w.ended_at IS NULL AND w.last_seen_at > now() - interval '75 seconds'
        AND coalesce(w.last_action_at, w.started_at) < now() - make_interval(secs => $1)
      ORDER BY coalesce(w.last_action_at, w.started_at) LIMIT 200`, [s]);
  const now = Date.now();
  return { seconds: s, rows: rows.map((r) => ({ ...r, user_id: r.user_id ? String(r.user_id) : null, status: statusOf(r, { now }),
    idle_seconds: Math.round((now - new Date(r.last_action_at || r.started_at)) / 1000) })) };
}

/* ── abandoned (spec §122) ── */
async function abandoned({ range = 'today' } = {}) {
  const per = await require('./analytics').funnel({ range }).then(() => null).catch(() => null);
  void per;
  const days = DAYS[range] ?? 0;
  const price = await REPORT_PAISE();
  const { rows } = await db.query(
    `WITH s AS (SELECT w.*, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name FROM web_sessions w LEFT JOIN users u ON u.id = w.user_id
                 WHERE w.started_at >= ${FROM(days)} AND (w.ended_at IS NOT NULL OR w.last_seen_at < now() - interval '10 minutes')),
     e AS (SELECT session_id,
                  bool_or(name = 'interaction' AND metadata->>'kind' = 'search') AS searched,
                  bool_or(name = 'interaction' AND metadata->>'kind' = 'view') AS saw,
                  bool_or(name = 'interaction' AND (metadata->>'label' ILIKE '%full report%' OR metadata->>'step' = 'paying')) AS cta,
                  max(reg_no) AS reg_no
             FROM events WHERE session_id IN (SELECT session_id FROM s) GROUP BY 1)
     SELECT s.session_id, s.user_id, s.mobile, s.name, s.started_at, s.last_seen_at, s.step, s.source, e.searched, e.saw, e.cta, e.reg_no,
            EXISTS (SELECT 1 FROM site_sign_ins i WHERE i.event = 'code_requested' AND i.created_at BETWEEN s.started_at AND s.last_seen_at + interval '5 minutes'
                     AND i.mobile IS NOT NULL AND (s.user_id IS NULL OR i.user_id = s.user_id)) AS code_asked,
            EXISTS (SELECT 1 FROM payments p WHERE p.user_id = s.user_id AND p.created_at BETWEEN s.started_at AND s.last_seen_at + interval '30 minutes') AS pay_started,
            EXISTS (SELECT 1 FROM payments p WHERE p.user_id = s.user_id AND p.status = 'paid' AND p.paid_at BETWEEN s.started_at AND s.last_seen_at + interval '30 minutes') AS paid
       FROM s LEFT JOIN e ON e.session_id = s.session_id ORDER BY s.last_seen_at DESC LIMIT 500`);
  const kindOf = (r) => (r.paid ? null : r.pay_started ? 'payment' : r.cta ? 'report' : r.step === 'code' || (r.code_asked && !r.user_id) ? 'otp'
    : r.searched && !r.saw ? 'search' : r.saw ? 'report' : null);
  const list = rows.map((r) => ({ ...r, user_id: r.user_id ? String(r.user_id) : null, kind: kindOf(r) })).filter((r) => r.kind);
  const label = { search: 'Search abandoned', otp: 'Sign-in abandoned at the code', report: 'Saw the vehicle, did not buy', payment: 'Payment abandoned' };
  return {
    range, price_paise: price,
    counts: Object.fromEntries(Object.keys(label).map((k) => [k, list.filter((r) => r.kind === k).length])),
    potential_paise: list.filter((r) => ['report', 'payment'].includes(r.kind)).length * price,
    rows: list.slice(0, 200).map((r) => ({ ...r, label: label[r.kind] })),
  };
}

/* ── computed insights (spec §55) ── */
async function insights({ range = 'today' } = {}) {
  const a = require('./analytics');
  const out = [];
  const sum = await a.summary({ range: range === '30d' ? '30d' : range === '7d' ? '7d' : 'today' });
  const c = sum.current; const p = sum.previous; const ch = sum.change;
  const conv = (x) => (x.visitors ? (100 * x.payments) / x.visitors : 0);
  const cc = conv(c); const pc = conv(p);
  if (c.visitors >= 5 && p.visitors >= 5 && Math.abs(cc - pc) >= 0.5) {
    out.push({ tone: cc >= pc ? 'good' : 'bad', text: `Visit-to-payment conversion is ${cc.toFixed(1)}%, ${cc >= pc ? 'up' : 'down'} from ${pc.toFixed(1)}% in the previous period.` });
  }
  if (ch.visitors != null && Math.abs(ch.visitors) >= 20) out.push({ tone: ch.visitors > 0 ? 'good' : 'bad', text: `Visitors are ${ch.visitors > 0 ? 'up' : 'down'} ${Math.abs(ch.visitors)}% (${c.visitors} against ${p.visitors}).` });
  if (c.otp_requests >= 3) {
    const r = Math.round((100 * c.otp_success) / c.otp_requests);
    out.push({ tone: r >= 70 ? 'good' : 'bad', text: `${r}% of sign-in codes sent led to a sign-in (${c.otp_success} of ${c.otp_requests}).` });
  }
  const lat = await db.one(
    `SELECT avg(duration_ms) FILTER (WHERE created_at > now() - interval '1 hour') AS h1,
            avg(duration_ms) FILTER (WHERE created_at <= now() - interval '1 hour' AND created_at > now() - interval '2 hours') AS h0,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS calls
       FROM api_calls WHERE NOT cache_hit AND created_at > now() - interval '2 hours'`);
  if (n(lat.calls) >= 5 && n(lat.h0) > 0) {
    const d = Math.round((100 * (n(lat.h1) - n(lat.h0))) / n(lat.h0));
    if (Math.abs(d) >= 20) out.push({ tone: d < 0 ? 'good' : 'bad', text: `Records-API latency ${d > 0 ? 'rose' : 'fell'} ${Math.abs(d)}% in the last hour (${Math.round(n(lat.h1))} ms on average).` });
  }
  const f = await a.funnel({ range: range === 'yesterday' ? 'yesterday' : range });
  const worst = f.stages.filter((s) => s.to_next_pct != null && s.count >= 3).sort((x, y) => x.to_next_pct - y.to_next_pct)[0];
  if (worst) out.push({ tone: 'info', text: `Most visitors stop after “${worst.label}”: only ${worst.to_next_pct}% go on (${worst.dropped} stopped there).` });
  const b = await breakdown({ range });
  const dev = b.devices.filter((x) => x.visits >= 5).sort((x, y) => y.conv - x.conv);
  if (dev.length >= 2 && dev[1].conv > 0 && dev[0].conv / dev[1].conv >= 1.3) out.push({ tone: 'info', text: `${dev[0].name} visitors convert ${(dev[0].conv / dev[1].conv).toFixed(1)}× better than ${dev[1].name}.` });
  const src = (await require('./web').overview({ range: range === 'yesterday' ? 'today' : range })).sources.filter((s) => s.revenue_paise > 0).sort((x, y) => y.revenue_paise - x.revenue_paise)[0];
  if (src) out.push({ tone: 'good', text: `${src.source.replace(/_/g, ' ')} brought the most revenue: ₹${Math.round(src.revenue_paise / 100)} from ${src.paid} payment${src.paid === 1 ? '' : 's'}.` });
  if (!out.length) out.push({ tone: 'info', text: 'Not enough activity in this period for a comparison yet.' });
  return { range, rows: out };
}

/* ── breakdowns (spec §33–35, §117, §119) ── */
async function breakdown({ range = 'today' } = {}) {
  const days = DAYS[range] ?? 0;
  const paidIn = `EXISTS (SELECT 1 FROM payments p WHERE p.user_id = w.user_id AND p.status = 'paid' AND p.paid_at BETWEEN w.started_at AND w.last_seen_at + interval '30 minutes')`;
  const group = async (expr) => (await db.query(
    `SELECT ${expr} AS name, count(*) AS visits, count(*) FILTER (WHERE w.user_id IS NOT NULL) AS signed_in, count(*) FILTER (WHERE ${paidIn}) AS paid
       FROM web_sessions w WHERE w.started_at >= ${FROM(days)} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`)).rows
    .map((r) => ({ name: r.name || 'Unknown', visits: n(r.visits), signed_in: n(r.signed_in), paid: n(r.paid), conv: n(r.visits) ? Math.round((1000 * n(r.paid)) / n(r.visits)) / 10 : 0 }));
  const [devices, browsers, systems, states, cities] = await Promise.all([
    group(`coalesce(w.device->>'device_type', 'Unknown')`), group(`coalesce(w.device->>'browser', 'Unknown')`), group(`coalesce(w.device->>'os', 'Unknown')`),
    group(`coalesce(nullif(w.place->>'region', ''), w.place->>'country', 'Unknown')`), group(`coalesce(nullif(w.place->>'city', ''), 'Unknown')`),
  ]);
  const { rows: pages } = await db.query(
    `SELECT e.page, count(*) AS views, count(DISTINCT e.session_id) AS sessions,
            (SELECT count(*) FROM web_sessions w WHERE w.started_at >= ${FROM(days)} AND w.page = e.page AND (w.ended_at IS NOT NULL OR w.last_seen_at < now() - interval '75 seconds')) AS exits
       FROM events e WHERE e.channel = 'web' AND e.name = 'page_view' AND e.occurred_at >= ${FROM(days)} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`);
  const { rows: clicks } = await db.query(
    `SELECT e.metadata->>'label' AS label, count(*) AS taps, count(DISTINCT e.session_id) AS sessions,
            count(DISTINCT e.session_id) FILTER (WHERE EXISTS (SELECT 1 FROM web_sessions w WHERE w.session_id = e.session_id AND ${paidIn})) AS then_paid
       FROM events e WHERE e.name = 'interaction' AND e.metadata->>'kind' = 'tap' AND e.occurred_at >= ${FROM(days)} GROUP BY 1 ORDER BY 2 DESC LIMIT 25`);
  const { rows: fields } = await db.query(
    `SELECT e.metadata->>'label' AS label, count(*) AS focus, count(DISTINCT e.session_id) AS sessions
       FROM events e WHERE e.name = 'interaction' AND e.metadata->>'kind' = 'focus' AND e.occurred_at >= ${FROM(days)} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
  const signin = await db.one(
    `SELECT (SELECT count(DISTINCT e.session_id) FROM events e WHERE e.name = 'interaction' AND e.metadata->>'kind' = 'focus'
               AND e.metadata->>'label' ILIKE '%mobile%' AND e.occurred_at >= ${FROM(days)}) AS started,
            (SELECT count(*) FROM site_sign_ins WHERE event = 'code_requested' AND created_at >= ${FROM(days)}) AS submitted,
            (SELECT count(*) FROM site_sign_ins WHERE event = 'signed_in' AND created_at >= ${FROM(days)}) AS completed,
            (SELECT count(*) FROM events e WHERE e.name = 'interaction' AND e.metadata->>'kind' = 'error' AND e.occurred_at >= ${FROM(days)}
               AND (e.metadata->>'label' ILIKE '%mobile%' OR e.metadata->>'label' ILIKE '%code%')) AS errors`);
  return {
    range, devices, browsers, systems, states, cities,
    pages: pages.map((r) => ({ page: r.page, views: n(r.views), sessions: n(r.sessions), exits: n(r.exits), exit_pct: n(r.sessions) ? Math.round((100 * n(r.exits)) / n(r.sessions)) : 0 })),
    clicks: clicks.map((r) => ({ label: r.label, taps: n(r.taps), sessions: n(r.sessions), then_paid: n(r.then_paid) })),
    fields: fields.map((r) => ({ label: r.label, focus: n(r.focus), sessions: n(r.sessions) })),
    forms: [{ name: 'Sign-in (mobile number → code → signed in)', started: n(signin.started), submitted: n(signin.submitted), completed: n(signin.completed), errors: n(signin.errors),
      // Field focus is recorded only since 7 Oct 2026; never fewer starts than submissions.
      abandoned: Math.max(0, n(signin.started) - n(signin.submitted)),
      conv_pct: Math.max(n(signin.started), n(signin.submitted)) ? Math.min(100, Math.round((100 * n(signin.completed)) / Math.max(n(signin.started), n(signin.submitted)))) : null }],
  };
}

/* ── one vehicle (spec §16) ── */
async function vehicle(reg) {
  const r = String(reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const v = await db.one(`SELECT id, reg_no, maker, model, fuel, vehicle_class, reg_date, insurance_upto, pucc_upto, tax_upto, fitness_upto, permit_upto, reg_upto, owner_serial, financer, blacklist_status, rc_status, first_seen_at, last_seen_at
                            FROM vehicles WHERE reg_no = $1`, [r]).catch(() => null);
  const [who, reps, api, checks] = await Promise.all([
    db.query(`SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, uv.check_count, uv.last_checked_at
                FROM user_vehicles uv JOIN users u ON u.id = uv.user_id JOIN vehicles x ON x.id = uv.vehicle_id WHERE x.reg_no = $1 ORDER BY uv.last_checked_at DESC NULLS LAST LIMIT 50`, [r]),
    db.query(`SELECT id, report_number, user_id, created_at, valid_until, channel FROM vehicle_reports WHERE reg_no = $1 ORDER BY id DESC LIMIT 50`, [r]),
    db.query(`SELECT id, created_at, dataset, ok, cache_hit, outcome, duration_ms, coalesce(error_message, error_code) AS err FROM api_calls WHERE reg_no = $1 ORDER BY id DESC LIMIT 60`, [r]),
    db.query(`SELECT count(*) FILTER (WHERE kind = 'chat_anon_check') AS free, count(*) FILTER (WHERE kind IN ('vehicle_check', 'vehicle_check_repeat')) AS signed_in
                FROM event_log WHERE detail->>'reg_no' = $1`, [r]),
  ]);
  return { reg_no: r, vehicle: v ? { ...v, id: String(v.id) } : null,
    customers: who.rows.map((x) => ({ ...x, id: String(x.id) })), reports: reps.rows.map((x) => ({ ...x, id: String(x.id), user_id: x.user_id ? String(x.user_id) : null })),
    api: api.rows.map((x) => ({ ...x, id: String(x.id), reg_no: r })), checks: { free: n(checks.rows[0]?.free), signed_in: n(checks.rows[0]?.signed_in) } };
}

module.exports = { leads, stuck, abandoned, insights, breakdown, vehicle, weights };
