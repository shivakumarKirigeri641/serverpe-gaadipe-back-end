/**
 * src/admin/payflow.js — how payments fail and where they stop (user,
 * 2026-09-25, operations module phase 2).
 * ---------------------------------------------------------------------------
 *   funnel(q)      page viewed → started → success, with failed, abandoned
 *                  and expired beside it; conversion at each stage;
 *                  failure reasons as Razorpay gave them; success by hour,
 *                  device and source
 *   abandoned(q)   payments started and not completed — who, which vehicle,
 *                  how long ago, why if known. Looking only: nothing is sent
 *                  to anyone from here.
 *   refunds(q)     refunded payments (GaadiPe's policy is no refunds; these
 *                  are Razorpay-initiated or exceptional)
 *
 * A "payment" here is a checkout for money (free reports are not attempts).
 * Stages that are not recorded say so ("Payment window opened" is not a
 * Razorpay event GaadiPe receives) rather than borrowing another number.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const command = require('./command');
const { describeDevice } = require('../pay/report');

const PAID_ONLY = `p.amount_paise > 0 AND coalesce(p.gateway, '') <> 'free' AND NOT (p.raw ? 'free')`;
const ABANDON_MIN = 30;
/* A checkout the customer replaced with one they paid (same vehicle, later) is not lost. */
const SUPERSEDED = `EXISTS (SELECT 1 FROM payments p2 WHERE p2.user_id = p.user_id AND p2.status IN ('paid', 'refunded')
                      AND p2.created_at >= p.created_at AND p2.raw->>'vehicle_id' IS NOT DISTINCT FROM p.raw->>'vehicle_id')`;

/* Razorpay's error_reason, grouped the way people talk about it. */
function reasonGroup(reason, code) {
  const r = String(reason || '').toLowerCase(); const c = String(code || '').toLowerCase();
  if (/insufficient/.test(r)) return 'Insufficient funds';
  if (/cancel|user_|timed_out|timeout|dropped/.test(r)) return 'Cancelled or timed out by the customer';
  if (/network|connect/.test(r)) return 'Network error';
  if (/otp|auth|pin|3ds|verification/.test(r)) return 'Authentication failure';
  if (/bank|gateway|technical|server|issuer|unavailable/.test(r) || /gateway_error|server_error/.test(c)) return 'Bank or gateway error';
  if (/declin|risk|invalid|limit/.test(r)) return 'Declined';
  return reason ? `Other (${reason})` : 'Unknown';
}

/* Each payment attempt's latest Razorpay failure, by payment row. */
const FAILURES = `
  SELECT DISTINCT ON (nullif(split_part(l.detail->>'reference_id', '-', 2), '')::bigint)
         nullif(split_part(l.detail->>'reference_id', '-', 2), '')::bigint AS payment_row_id,
         l.detail->>'error_reason' AS reason, l.detail->>'error_code' AS code, l.detail->>'error_description' AS description,
         l.detail->>'method' AS method, l.created_at
    FROM event_log l
   WHERE l.kind = 'razorpay_webhook' AND l.detail->>'event' = 'payment.failed' AND l.detail->>'reference_id' LIKE 'gp-%'
   ORDER BY nullif(split_part(l.detail->>'reference_id', '-', 2), '')::bigint, l.id DESC`;

async function funnel(q = {}) {
  const r = command.resolve({ ...q, range: q.range || '7d', compare: 'none' });
  const a = [r.from, r.to];
  const [ev, pay, reasons, byHour, rows] = await Promise.all([
    db.one(`SELECT count(DISTINCT coalesce(e.payment_id::text, e.event_key)) FILTER (WHERE e.name = 'payment_page_viewed')::int AS page_viewed,
                   count(DISTINCT coalesce(e.payment_id::text, e.event_key)) FILTER (WHERE e.name = 'payment_started')::int AS started_events
              FROM events e WHERE e.occurred_at >= $1 AND e.occurred_at < $2`, a),
    db.one(`SELECT count(*)::int AS started,
                   count(*) FILTER (WHERE p.status IN ('paid', 'refunded'))::int AS success,
                   count(*) FILTER (WHERE p.status = 'created' AND NOT ${SUPERSEDED} AND f.payment_row_id IS NOT NULL)::int AS failed,
                   count(*) FILTER (WHERE p.status = 'created' AND ${SUPERSEDED})::int AS superseded,
                   count(*) FILTER (WHERE p.status = 'created' AND NOT ${SUPERSEDED} AND f.payment_row_id IS NULL AND p.created_at < now() - interval '${ABANDON_MIN} minutes'
                                      AND p.created_at > now() - interval '24 hours')::int AS abandoned,
                   count(*) FILTER (WHERE p.status = 'created' AND NOT ${SUPERSEDED} AND f.payment_row_id IS NULL AND p.created_at <= now() - interval '24 hours')::int AS expired,
                   count(*) FILTER (WHERE p.status = 'created' AND p.created_at >= now() - interval '${ABANDON_MIN} minutes')::int AS in_progress,
                   count(*) FILTER (WHERE f.payment_row_id IS NOT NULL)::int AS had_failure,
                   count(*) FILTER (WHERE f.payment_row_id IS NOT NULL AND p.status IN ('paid', 'refunded'))::int AS recovered_after_failure
              FROM payments p LEFT JOIN (${FAILURES}) f ON f.payment_row_id = p.id
             WHERE ${PAID_ONLY} AND p.created_at >= $1 AND p.created_at < $2`, a),
    db.query(`SELECT f.reason, f.code, count(*)::int AS n FROM (${FAILURES}) f JOIN payments p ON p.id = f.payment_row_id
               WHERE p.created_at >= $1 AND p.created_at < $2 GROUP BY 1, 2 ORDER BY 3 DESC`, a),
    db.query(`SELECT extract(hour FROM p.created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, count(*)::int AS started,
                     count(*) FILTER (WHERE p.status IN ('paid', 'refunded'))::int AS success
                FROM payments p WHERE ${PAID_ONLY} AND p.created_at >= $1 AND p.created_at < $2 GROUP BY 1 ORDER BY 1`, a),
    db.query(`SELECT p.id, p.status, p.raw->'paid_from'->>'userAgent' AS ua, coalesce(p.raw->>'channel', p.raw->'paid_from'->>'channel') AS channel,
                     (SELECT vi.first_touch->>'source' FROM visitors vi WHERE vi.user_id = p.user_id OR vi.mobile = u.mobile ORDER BY vi.first_seen_at LIMIT 1) AS source
                FROM payments p LEFT JOIN users u ON u.id = p.user_id
               WHERE ${PAID_ONLY} AND p.created_at >= $1 AND p.created_at < $2`, a),
  ]);
  const rate = (x, y) => (y ? Math.round((x / y) * 1000) / 10 : null);
  const groups = {};
  for (const x of reasons.rows) { const g = reasonGroup(x.reason, x.code); groups[g] = (groups[g] || 0) + x.n; }
  const tally = (keyOf) => {
    const m = {};
    for (const x of rows.rows) {
      const k = keyOf(x); m[k] = m[k] || { key: k, started: 0, success: 0 };
      m[k].started += 1; if (['paid', 'refunded'].includes(x.status)) m[k].success += 1;
    }
    return Object.values(m).map((g) => ({ ...g, rate: rate(g.success, g.started) })).sort((p, q2) => q2.started - p.started);
  };
  const stages = [
    { key: 'page_viewed', label: 'Payment page viewed', n: ev.page_viewed, note: 'Checkout pages opened (website).' },
    { key: 'started', label: 'Payment initiated', n: pay.started, note: 'Checkouts / payment links created for a paid report.' },
    { key: 'window', label: 'Payment window opened', n: null, note: 'Razorpay does not tell GaadiPe when its window opens — not recorded.' },
    { key: 'success', label: 'Payment successful', n: pay.success },
    { key: 'failed', label: 'Payment failed', n: pay.failed, note: 'Razorpay reported a failed attempt and the customer did not pay afterwards.', side: true },
    { key: 'cancelled', label: 'Payment cancelled', n: groups['Cancelled or timed out by the customer'] || 0, note: 'Failed attempts Razorpay put down to the customer cancelling or timing out.', side: true },
    { key: 'abandoned', label: 'Payment abandoned', n: pay.abandoned, note: `Started, no attempt reported, not paid after ${ABANDON_MIN} minutes.`, side: true },
    { key: 'expired', label: 'Payment expired', n: pay.expired, note: 'Unpaid after 24 hours.', side: true },
    { key: 'superseded', label: 'Replaced by a paid checkout', n: pay.superseded, note: 'The customer started again and paid for the same vehicle.', side: true },
  ];
  return {
    range: { label: r.label },
    stages: stages.map((s) => ({ ...s, pct_of_started: s.n == null ? null : rate(s.n, pay.started) })),
    in_progress: pay.in_progress,
    success_rate: rate(pay.success, pay.started), failure_rate: rate(pay.failed, pay.started),
    recovered_after_failure: pay.recovered_after_failure, had_failure: pay.had_failure,
    reasons: Object.entries(groups).map(([label, n]) => ({ label, n })).sort((x, y) => y.n - x.n),
    raw_reasons: reasons.rows,
    by_hour: Array.from({ length: 24 }, (_, h) => {
      const x = byHour.rows.find((b) => b.hour === h) || { started: 0, success: 0 };
      return { hour: h, started: x.started, success: x.success, rate: rate(x.success, x.started) };
    }),
    by_device: tally((x) => (x.ua ? describeDevice(x.ua) : x.channel === 'whatsapp' || !x.channel ? 'Not recorded (WhatsApp link)' : 'Not recorded')),
    by_source: tally((x) => x.source || 'direct'),
  };
}

const WINDOWS = { '1h': `now() - interval '1 hour'`, today: `date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
  yesterday: `date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' - interval '1 day'`, '7d': `now() - interval '7 days'` };

async function abandoned(q = {}) {
  const win = WINDOWS[q.window] ? q.window : 'today';
  const until = win === 'yesterday' ? `date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'` : 'now()';
  const limit = Math.min(200, Number(q.limit) || 50); const offset = Math.max(0, Number(q.offset) || 0);
  const { rows } = await db.query(
    `SELECT p.id, p.order_id, p.amount_paise, p.created_at, p.user_id, u.mobile, v.reg_no,
            coalesce(p.raw->>'channel', p.raw->'paid_from'->>'channel', 'whatsapp') AS channel,
            f.reason, f.code, f.description, f.created_at AS failed_at,
            (SELECT max(e.occurred_at) FROM events e WHERE e.user_id = p.user_id AND e.occurred_at >= p.created_at) AS last_activity,
            ft.first_touch, ws.attribution,
            count(*) OVER () AS total_rows
       FROM payments p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN vehicles v ON p.raw ? 'vehicle_id' AND v.id::text = p.raw->>'vehicle_id'
       LEFT JOIN (${FAILURES}) f ON f.payment_row_id = p.id
       LEFT JOIN LATERAL (SELECT vi.first_touch FROM visitors vi WHERE vi.user_id = p.user_id OR vi.mobile = u.mobile ORDER BY vi.first_seen_at LIMIT 1) ft ON true
       LEFT JOIN LATERAL (SELECT s.attribution FROM whatsapp_sessions s WHERE s.user_id = p.user_id ORDER BY s.id DESC LIMIT 1) ws ON true
      WHERE ${PAID_ONLY} AND p.status = 'created'
        AND p.created_at >= ${WINDOWS[win]} AND p.created_at < ${until}
        AND p.created_at < now() - interval '${win === '1h' ? 0 : ABANDON_MIN} minutes'
        -- Paid later by another checkout for the same vehicle is not abandoned.
        AND NOT ${SUPERSEDED}
      ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${offset}`);
  return {
    window: win, total: rows[0] ? Number(rows[0].total_rows) : 0,
    note: 'Looking only — no message is sent from this screen. Recovery messages are a separate, controlled feature.',
    rows: rows.map((x) => {
      const touch = x.attribution?.first_touch || x.first_touch || null;
      const age = Math.round((Date.now() - new Date(x.created_at)) / 60000);
      return {
        id: String(x.id), order_id: x.order_id, amount_paise: x.amount_paise, started_at: x.created_at, last_activity: x.last_activity,
        user_id: x.user_id ? String(x.user_id) : null, mobile: x.mobile, reg_no: x.reg_no, channel: x.channel,
        source: touch?.source || 'direct', campaign: touch?.campaign || null,
        reason: x.reason ? reasonGroup(x.reason, x.code) : age > 24 * 60 ? 'Expired unpaid' : 'Left without paying',
        reason_detail: x.description || null, minutes_since: age,
      };
    }),
  };
}

async function refunds(q = {}) {
  const r = command.resolve({ ...q, range: q.range || '30d', compare: 'none' });
  const { rows } = await db.query(
    `SELECT p.id, p.payment_id, p.refund_id, p.amount_paise, (p.raw->'refund'->>'amount')::int AS refund_amount,
            p.paid_at, p.refunded_at, u.mobile, v.reg_no, p.raw->'refund'->>'status' AS refund_status
       FROM payments p LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN vehicles v ON p.raw ? 'vehicle_id' AND v.id::text = p.raw->>'vehicle_id'
      WHERE (p.status = 'refunded' OR p.refunded_at IS NOT NULL) AND coalesce(p.refunded_at, p.created_at) >= $1 AND coalesce(p.refunded_at, p.created_at) < $2
      ORDER BY p.refunded_at DESC NULLS LAST`, [r.from, r.to]);
  return {
    range: { label: r.label },
    note: 'GaadiPe does not refund from the admin panel. Refunds made at Razorpay arrive by webhook and are shown here.',
    total_paise: rows.reduce((s, x) => s + Number(x.refund_amount ?? x.amount_paise), 0),
    rows: rows.map((x) => ({ ...x, id: String(x.id), refund_paise: x.refund_amount ?? x.amount_paise })),
  };
}

module.exports = { funnel, abandoned, refunds, reasonGroup };
