/**
 * src/admin/opsExtras.js — the admin additions of 2026-10-01 (user):
 * ---------------------------------------------------------------------------
 *   adSpend           what was spent on ads per day, against new and paying
 *                     customers that day — cost per customer, cost per paying
 *                     customer, revenue per rupee of ads
 *   whyNotPaid        everyone shown a free check, split by what it showed
 *                     (all clear, one thing, two or more, challans pending),
 *                     and how far each group got: tapped ₹19, got the link, paid
 *   waLimit           business-started conversations in the last 24 hours on
 *                     GaadiPe's number, against the Meta messaging limit
 *   reply             a free-text reply to a customer inside their 24-hour window
 *   broadcastCosts    each broadcast's sent / delivered / read / failed and what
 *                     it cost; template messages by month and Meta category
 *   waitlist          the numbers waiting for the vehicle records service
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const settings = require('../util/settings');

const IST_DAY = (col) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`;
const REAL_USER = `NOT coalesce(u.is_internal, false)`;

/* ───────────────────────────────────────────────────────────── ad spend ── */

async function adSpend({ days = 60, product = 'gaadipe' } = {}) {
  const n = Math.min(365, Math.max(7, Number(days) || 60));
  const { rows } = await db.query(
    `WITH d AS (SELECT generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - ($1::int - 1), (now() AT TIME ZONE 'Asia/Kolkata')::date, '1 day')::date AS day)
     SELECT d.day,
            (SELECT a.id FROM ad_spend a WHERE a.day = d.day AND a.product = $2 AND a.channel = 'meta') AS id,
            coalesce((SELECT sum(a.amount_paise) FROM ad_spend a WHERE a.day = d.day AND a.product = $2), 0)::int AS spend_paise,
            (SELECT a.note FROM ad_spend a WHERE a.day = d.day AND a.product = $2 AND a.channel = 'meta') AS note,
            (SELECT count(*) FROM users u WHERE ${IST_DAY('u.created_at')} = d.day AND ${REAL_USER})::int AS new_customers,
            (SELECT count(DISTINCT p.user_id) FROM payments p JOIN users u ON u.id = p.user_id
              WHERE p.status = 'paid' AND p.amount_paise > 0 AND ${IST_DAY('p.paid_at')} = d.day AND ${REAL_USER})::int AS paying,
            (SELECT coalesce(sum(p.amount_paise), 0) FROM payments p JOIN users u ON u.id = p.user_id
              WHERE p.status = 'paid' AND p.amount_paise > 0 AND ${IST_DAY('p.paid_at')} = d.day AND ${REAL_USER})::int AS revenue_paise
       FROM d ORDER BY d.day DESC`, [n, product]);
  const sum = (list, k) => list.reduce((a, r) => a + Number(r[k] || 0), 0);
  const window = (k) => {
    const list = rows.slice(0, k);
    const spend = sum(list, 'spend_paise'); const cust = sum(list, 'new_customers'); const pay = sum(list, 'paying'); const rev = sum(list, 'revenue_paise');
    return { days: k, spend_paise: spend, new_customers: cust, paying: pay, revenue_paise: rev,
      cost_per_customer_paise: cust ? Math.round(spend / cust) : null,
      cost_per_paying_paise: pay ? Math.round(spend / pay) : null,
      revenue_per_rupee: spend ? Math.round((rev / spend) * 100) / 100 : null };
  };
  return { product, windows: [window(7), window(30)], rows: rows.map((r) => ({ ...r, id: r.id ? String(r.id) : null, day: String(r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day).slice(0, 10) })) };
}

async function saveAdSpend({ day, amount, product = 'gaadipe', note }, adminId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw Object.assign(new Error('Choose a date.'), { status: 400 });
  const paise = Math.round(Number(amount) * 100);
  if (!Number.isFinite(paise) || paise < 0 || paise > 10000000) throw Object.assign(new Error('Enter an amount in rupees.'), { status: 400 });
  if (!['gaadipe', 'quizpe'].includes(product)) throw Object.assign(new Error('Unknown product.'), { status: 400 });
  await db.query(
    `INSERT INTO ad_spend (day, product, channel, amount_paise, note, created_by) VALUES ($1, $2, 'meta', $3, $4, $5)
     ON CONFLICT (day, product, channel) DO UPDATE SET amount_paise = EXCLUDED.amount_paise, note = EXCLUDED.note, modified_at = now()`,
    [day, product, paise, String(note || '').slice(0, 200) || null, adminId || null]);
  return { ok: true };
}

const removeAdSpend = (id) => db.query(`DELETE FROM ad_spend WHERE id = $1`, [id]);

/** Spend in [from, to) — for the weekly money report. */
async function spendBetween(from, to, product = 'gaadipe') {
  const r = await db.one(
    `SELECT coalesce(sum(amount_paise), 0)::int AS paise FROM ad_spend
      WHERE product = $3 AND day >= ${IST_DAY('$1::timestamptz')} AND day < ${IST_DAY('$2::timestamptz')}`, [from, to, product]).catch(() => null);
  return r ? r.paise : 0;
}

/* ────────────────────────────────────────────────── why didn't they pay ── */

async function whyNotPaid({ days = 30 } = {}) {
  const n = Math.min(180, Math.max(1, Number(days) || 30));
  const { rows } = await db.query(
    `WITH shown AS (
       SELECT DISTINCT ON (e.mobile, e.reg_no) e.mobile, e.reg_no, e.user_id, e.occurred_at AS at
         FROM events e
        WHERE e.name = 'vehicle_search_success' AND e.channel = 'whatsapp' AND e.reg_no IS NOT NULL AND e.mobile IS NOT NULL
          AND e.occurred_at > now() - make_interval(days => $1)
          AND NOT EXISTS (SELECT 1 FROM users ui WHERE ui.is_internal AND ui.mobile = e.mobile)
        ORDER BY e.mobile, e.reg_no, e.occurred_at
     )
     SELECT s.mobile, s.reg_no, s.at,
            coalesce(u.display_name, u.wa_profile_name) AS name, u.id AS user_id,
            ((v.insurance_upto < CURRENT_DATE)::int + (v.pucc_upto < CURRENT_DATE)::int + (v.fitness_upto < CURRENT_DATE)::int
              + (v.tax_upto < CURRENT_DATE)::int) AS expired,
            coalesce((SELECT (x.data->>'pending_count')::int FROM vehicle_snapshots x WHERE x.vehicle_id = v.id AND x.dataset = 'challan'), 0) AS challans,
            EXISTS (SELECT 1 FROM events t WHERE t.mobile = s.mobile AND t.name = 'report_preview_viewed' AND t.occurred_at >= s.at
                      AND (t.reg_no = s.reg_no OR t.reg_no IS NULL)) AS tapped,
            EXISTS (SELECT 1 FROM events t WHERE t.mobile = s.mobile AND t.name = 'payment_started' AND t.occurred_at >= s.at
                      AND (t.reg_no = s.reg_no OR t.reg_no IS NULL)) AS link,
            EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0
                      AND coalesce(p.paid_at, p.created_at) >= s.at AND (p.raw->>'vehicle_id')::bigint = v.id) AS paid
       FROM shown s
       LEFT JOIN users u ON u.mobile = s.mobile
       LEFT JOIN vehicles v ON v.reg_no = s.reg_no
      ORDER BY s.at DESC`, [n]);
  const group = (r) => (r.expired === 0 && r.challans === 0 ? 'clear' : r.expired + (r.challans > 0 ? 1 : 0) === 1 ? 'one' : 'more');
  const LABEL = { clear: 'Nothing needed attention', one: 'One thing needed attention', more: 'Two or more things needed attention' };
  const groups = ['clear', 'one', 'more'].map((g) => {
    const list = rows.filter((r) => group(r) === g);
    const c = (k) => list.filter((r) => r[k]).length;
    return { key: g, label: LABEL[g], shown: list.length, tapped: c('tapped'), link: c('link'), paid: c('paid'),
      paid_pct: list.length ? Math.round((c('paid') / list.length) * 1000) / 10 : null };
  });
  const challanGroup = (() => {
    const list = rows.filter((r) => r.challans > 0);
    return { shown: list.length, paid: list.filter((r) => r.paid).length };
  })();
  const stuck = rows.filter((r) => !r.paid).slice(0, 100).map((r) => ({
    mobile: r.mobile, masked: `…${String(r.mobile).slice(-4)}`, name: r.name, reg_no: r.reg_no, at: r.at, group: group(r),
    expired: r.expired, challans: r.challans,
    reached: r.link ? 'Got the payment link' : r.tapped ? 'Tapped ₹19' : 'Saw the free check',
  }));
  return { days: n, total: rows.length, paid: rows.filter((r) => r.paid).length, groups, challans: challanGroup, stuck };
}

/* ────────────────────────────────────────────────────────── WhatsApp limit ── */

async function waLimit() {
  const limit = await settings.num('whatsapp_messaging_limit', 250);
  const r = await db.one(
    `SELECT count(DISTINCT mobile)::int AS used FROM whatsapp_messages
      WHERE direction = 'out' AND message_type = 'template' AND created_at > now() - interval '24 hours'
        AND coalesce(error_message, '') = ''`);
  // Live from Meta (jobs/metaStatus.js): the tier, quality and account checks.
  const meta = await require('../jobs/metaStatus').current().catch(() => null);
  return { limit, used: r.used, remaining: Math.max(0, limit - r.used), meta,
    note: 'GaadiPe’s number only. QuizPe shares the same Meta limit and is not counted here — WhatsApp Manager shows the total.' };
}

/* ─────────────────────────────────────────────────────────────── reply ── */

async function reply(mobile, text, adminId) {
  const send = require('../whatsapp/send');
  const m = String(mobile || '').replace(/\D/g, '').slice(-10);
  const body = String(text || '').trim().slice(0, 1000);
  if (m.length !== 10) throw Object.assign(new Error('Not a mobile number.'), { status: 400 });
  if (!body) throw Object.assign(new Error('Write a message first.'), { status: 400 });
  if (!(await send.windowOpen(m))) {
    throw Object.assign(new Error('Their 24-hour window has closed — only an approved template can reach them now.'), { status: 409 });
  }
  const out = await send.text(m, body);
  if (!out?.ok) throw Object.assign(new Error(`WhatsApp did not accept it: ${out?.error || 'unknown'}`), { status: 502 });
  return { ok: true, id: out.id || null };
}

/* ────────────────────────────────────────────────────── broadcast costs ── */

async function broadcastCosts() {
  // The same per-category rates the cost page and the ledger use (Settings).
  const R = await require('./whatsappOps').rates();
  const price = (cat) => R[String(cat || '').toUpperCase()] ?? R.OTHER;
  const { rows } = await db.query(
    `SELECT b.id, b.template_name, b.created_at, b.status, b.recipients,
            upper(coalesce((SELECT t.category FROM wa_templates t WHERE t.template_name = b.template_name LIMIT 1), 'UNKNOWN')) AS category,
            count(t.*) FILTER (WHERE t.status = 'sent')::int AS sent,
            count(t.*) FILTER (WHERE t.status = 'failed')::int AS failed,
            count(t.*) FILTER (WHERE t.status = 'skipped')::int AS skipped,
            count(t.*) FILTER (WHERE d.status IN ('delivered', 'read'))::int AS delivered,
            count(t.*) FILTER (WHERE d.status = 'read')::int AS read
       FROM whatsapp_broadcasts b
       LEFT JOIN whatsapp_broadcast_targets t ON t.broadcast_id = b.id
       LEFT JOIN LATERAL (
         SELECT s.status FROM whatsapp_status_logs s WHERE t.wa_message_id IS NOT NULL AND s.wa_message_id = t.wa_message_id
          ORDER BY CASE s.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'failed' THEN 1 ELSE 0 END DESC LIMIT 1) d ON true
      GROUP BY b.id ORDER BY b.id DESC LIMIT 100`);
  const months = await db.query(
    `SELECT to_char(m.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month,
            upper(coalesce(t.category, 'UNKNOWN')) AS category,
            count(*) FILTER (WHERE coalesce(m.error_message, '') = ''
                 AND NOT (upper(coalesce(t.category, '')) = 'UTILITY' AND EXISTS (
                   SELECT 1 FROM whatsapp_messages wi WHERE wi.mobile = m.mobile AND wi.direction = 'in'
                      AND wi.created_at <= m.created_at AND wi.created_at > m.created_at - interval '24 hours')))::int AS n
       FROM whatsapp_messages m
       LEFT JOIN LATERAL (SELECT category FROM wa_templates x WHERE x.template_name = m.template_name LIMIT 1) t ON true
      WHERE m.direction = 'out' AND m.message_type = 'template' AND m.created_at > now() - interval '12 months'
      GROUP BY 1, 2 ORDER BY 1 DESC, 2`);
  const broadcasts = rows.map((b) => ({ ...b, id: String(b.id), rate_paise: price(b.category), cost_paise: b.sent * price(b.category) }));
  const byMonth = {};
  for (const r of months.rows) {
    const x = (byMonth[r.month] = byMonth[r.month] || { month: r.month, messages: 0, cost_paise: 0, categories: {} });
    x.messages += r.n; x.cost_paise += r.n * price(r.category); x.categories[r.category] = r.n;
  }
  const total = broadcasts.reduce((a, b) => ({ broadcasts: a.broadcasts + 1, sent: a.sent + b.sent, cost_paise: a.cost_paise + b.cost_paise }),
    { broadcasts: 0, sent: 0, cost_paise: 0 });
  return { rates: R, total, broadcasts, months: Object.values(byMonth) };
}

/* ───────────────────────────────────────────────────────────── waitlist ── */

async function waitlist() {
  const { rows } = await db.query(
    `SELECT w.id, w.mobile, w.reg_no, w.status, w.created_at, w.done_at, w.note,
            coalesce(u.display_name, u.wa_profile_name) AS name
       FROM lookup_waitlist w LEFT JOIN users u ON u.id = w.user_id
      WHERE w.status = 'waiting' OR w.created_at > now() - interval '3 days'
      ORDER BY (w.status = 'waiting') DESC, w.created_at DESC LIMIT 200`);
  return { rows: rows.map((r) => ({ ...r, id: String(r.id), masked: `…${String(r.mobile).slice(-4)}` })) };
}

module.exports = { adSpend, saveAdSpend, removeAdSpend, spendBetween, whyNotPaid, waLimit, reply, broadcastCosts, waitlist };
