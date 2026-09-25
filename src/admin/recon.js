/**
 * src/admin/recon.js — Payment reconciliation (user, 2026-09-25, operations
 * module phase 2): GaadiPe's payment records against Razorpay's.
 * ---------------------------------------------------------------------------
 *   run({from, to, adminId})  read both sides for the window and record one
 *                             item per payment: matched, missing on either
 *                             side, amount / status / refund mismatch,
 *                             webhook missing, pending, or requires review
 *   runs(), items(q), review(id, …)
 *
 * READ-ONLY TOWARDS MONEY. A run changes no payment; recovering a paid-but-
 * unrecorded payment is src/jobs/reconcile.js's job and a person's decision.
 * Razorpay's keys stay in src/pay/razorpay.js; nothing here sees them.
 * Settlement status is not in a payment's own record at Razorpay, so it is
 * shown as not available rather than guessed.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const rzp = require('../pay/razorpay');

const RESULTS = ['matched', 'missing_from_gateway', 'missing_internally', 'amount_mismatch', 'status_mismatch',
  'webhook_missing', 'refund_mismatch', 'requires_review', 'pending'];
const MAX = 500;
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

/* Did a Razorpay webhook tell us about this payment? */
async function webhookSeen(row, gatewayId) {
  const r = await db.one(
    `SELECT 1 AS ok FROM event_log WHERE kind = 'razorpay_webhook'
        AND (detail->>'payment_id' = $1 OR detail->>'reference_id' = $2 OR detail->>'reference_id' LIKE $3) LIMIT 1`,
    [gatewayId || '', `gp-${row.id}`, `gp-${row.id}-%`]);
  return Boolean(r);
}

/** Compare one of our payments with what Razorpay holds. */
async function checkOne(row) {
  const item = { payment_row_id: row.id, order_id: row.order_id, gateway_payment_id: row.payment_id,
    internal_amount: row.amount_paise, internal_status: row.status, detail: {} };
  let gw = null;
  try {
    if (row.payment_id && /^pay_/.test(row.payment_id)) {
      gw = await rzp.getPayment(row.payment_id);
    } else if (row.order_id && /^order_/.test(row.order_id)) {
      const list = await rzp.getOrderPayments(row.order_id);
      const items = list?.items || [];
      gw = items.find((p) => p.status === 'captured') || items.find((p) => p.status === 'refunded') || items[0] || null;
      item.detail.attempts = items.length;
      if (!gw && row.status === 'created') return { ...item, result: 'pending', detail: { ...item.detail, note: 'No attempt at Razorpay yet — unpaid on both sides.' } };
    } else if (row.order_id && /^plink_/.test(row.order_id)) {
      const link = await rzp.getLink(row.order_id);
      const paid = (link?.payments || []).find((p) => p.status === 'captured');
      if (paid?.payment_id) gw = await rzp.getPayment(paid.payment_id);
      item.detail.link_status = link?.status || null;
      if (!gw && row.status === 'created') {
        return { ...item, result: 'pending', gateway_status: link?.status || null, detail: { ...item.detail, note: `Payment link ${link?.status || 'not paid'} — unpaid on both sides.` } };
      }
    } else {
      return { ...item, result: row.status === 'created' ? 'pending' : 'requires_review', detail: { note: 'No Razorpay order, link or payment ID on this payment.' } };
    }
  } catch (e) {
    const notFound = /not.?found|does not exist|BAD_REQUEST/i.test(String(e.message));
    return { ...item, result: notFound ? 'missing_from_gateway' : 'requires_review', detail: { note: notFound ? 'Razorpay does not know this payment.' : `Razorpay did not answer: ${String(e.message).slice(0, 120)}` } };
  }
  if (!gw) return { ...item, result: row.status === 'created' ? 'pending' : 'missing_from_gateway', detail: { ...item.detail, note: 'No payment at Razorpay for this record.' } };

  Object.assign(item, {
    gateway_payment_id: gw.id, gateway_amount: gw.amount ?? null, gateway_status: gw.status || null,
    refund_status: gw.refund_status || null,
  });
  item.detail = { ...item.detail, method: gw.method || null, fee: gw.fee ?? null, tax: gw.tax ?? null,
    error_reason: gw.error_reason || null, captured_at: gw.created_at ? new Date(gw.created_at * 1000) : null };
  item.webhook_seen = await webhookSeen(row, gw.id);

  const oursPaid = row.status === 'paid'; const oursRefunded = row.status === 'refunded';
  const theirsPaid = gw.status === 'captured'; const theirsRefunded = gw.status === 'refunded' || Boolean(gw.refund_status);
  if (gw.amount != null && Number(gw.amount) !== Number(row.amount_paise)) return { ...item, result: 'amount_mismatch' };
  if (oursRefunded !== theirsRefunded && (oursRefunded || theirsRefunded)) return { ...item, result: 'refund_mismatch' };
  if ((oursPaid || oursRefunded) !== (theirsPaid || theirsRefunded)) {
    return { ...item, result: gw.status === 'failed' && row.status === 'created' ? 'pending' : 'status_mismatch',
      detail: { ...item.detail, note: theirsPaid && !oursPaid ? 'Paid at Razorpay, not recorded as paid here.' : oursPaid && !theirsPaid ? 'Recorded as paid here, not captured at Razorpay.' : 'Attempt failed at Razorpay; unpaid here.' } };
  }
  if ((oursPaid || oursRefunded) && !item.webhook_seen) return { ...item, result: 'webhook_missing', detail: { ...item.detail, note: 'Settled without a Razorpay webhook (browser callback or the reconciler).' } };
  if (!oursPaid && !oursRefunded) return { ...item, result: 'pending' };
  return { ...item, result: 'matched' };
}

/** Razorpay payments in the window that GaadiPe has no record of. */
async function missingInternally(from, to) {
  const out = [];
  for (let skip = 0; skip < MAX; skip += 100) {
    const page = await rzp.listPayments({ from, to, skip, count: 100 });
    const items = page?.items || [];
    for (const p of items) {
      if (!['captured', 'refunded'].includes(p.status)) continue;
      const known = await db.one(`SELECT id FROM payments WHERE payment_id = $1 OR (order_id IS NOT NULL AND order_id = $2) LIMIT 1`, [p.id, p.order_id || '']);
      if (!known) {
        out.push({ payment_row_id: null, gateway_payment_id: p.id, order_id: p.order_id || null, result: 'missing_internally',
          gateway_amount: p.amount ?? null, gateway_status: p.status, refund_status: p.refund_status || null,
          detail: { method: p.method || null, note: 'Razorpay has this payment; GaadiPe has no record of it.',
                    captured_at: p.created_at ? new Date(p.created_at * 1000) : null } });
      }
    }
    if (items.length < 100) break;
    await pause(200);
  }
  return out;
}

async function run({ from, to, adminId = null } = {}) {
  const r = await db.one(`INSERT INTO recon_runs (admin_id, range_from, range_to) VALUES ($1, $2, $3) RETURNING id`, [adminId, from, to]);
  try {
    if (!rzp.configured()) throw new Error('Razorpay is not configured on this server.');
    const { rows } = await db.query(
      `SELECT id, order_id, payment_id, status, amount_paise, gateway FROM payments
        WHERE created_at >= $1 AND created_at < $2 AND amount_paise > 0 AND coalesce(gateway, 'razorpay') NOT IN ('free')
          AND NOT (raw ? 'free') ORDER BY id LIMIT ${MAX}`, [from, to]);
    const items = [];
    for (const row of rows) { items.push(await checkOne(row)); await pause(120); }
    items.push(...await missingInternally(from, to));
    for (const it of items) {
      await db.query(
        `INSERT INTO recon_items (run_id, payment_row_id, gateway_payment_id, order_id, result, internal_amount, gateway_amount,
                                  internal_status, gateway_status, refund_status, webhook_seen, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [r.id, it.payment_row_id, it.gateway_payment_id || null, it.order_id || null, it.result, it.internal_amount ?? null, it.gateway_amount ?? null,
         it.internal_status || null, it.gateway_status || null, it.refund_status || null, it.webhook_seen ?? null, JSON.stringify(it.detail || {})]);
    }
    const count = (k) => items.filter((i) => i.result === k).length;
    const summary = {
      total: items.length, matched: count('matched'), pending: count('pending'),
      mismatched: count('amount_mismatch') + count('status_mismatch'), missing: count('missing_from_gateway') + count('missing_internally'),
      refund_issues: count('refund_mismatch'), webhook_missing: count('webhook_missing'), requires_review: count('requires_review'),
      by_result: Object.fromEntries(RESULTS.map((k) => [k, count(k)])), capped: rows.length >= MAX,
    };
    await db.query(`UPDATE recon_runs SET status = 'done', finished_at = now(), summary = $2 WHERE id = $1`, [r.id, JSON.stringify(summary)]);
    return { ok: true, id: String(r.id), summary };
  } catch (e) {
    await db.query(`UPDATE recon_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [r.id, String(e.message).slice(0, 300)]);
    return { ok: false, id: String(r.id), message: String(e.message).slice(0, 300) };
  }
}

async function runs() {
  const { rows } = await db.query(
    `SELECT r.id, r.started_at, r.finished_at, r.range_from, r.range_to, r.status, r.summary, r.error, a.name AS admin
       FROM recon_runs r LEFT JOIN admin_users a ON a.id = r.admin_id ORDER BY r.id DESC LIMIT 30`);
  return { rows: rows.map((x) => ({ ...x, id: String(x.id), admin: x.admin || 'Daily run' })) };
}

async function items(q = {}) {
  const run = q.run ? Number(q.run) : Number((await db.one(`SELECT max(id) AS id FROM recon_runs WHERE status = 'done'`))?.id || 0);
  if (!run) return { run: null, rows: [], total: 0 };
  const args = [run]; const w = ['i.run_id = $1'];
  if (RESULTS.includes(q.result)) { args.push(q.result); w.push(`i.result = $${args.length}`); }
  if (q.problems === '1') w.push(`i.result NOT IN ('matched', 'pending')`);
  if (q.unreviewed === '1') w.push('i.reviewed_at IS NULL');
  const limit = Math.min(200, Number(q.limit) || 50); const offset = Math.max(0, Number(q.offset) || 0);
  const { rows } = await db.query(
    `SELECT i.*, p.created_at AS p_created, p.paid_at, p.refunded_at, u.mobile, v.reg_no, ra.name AS reviewed_by_name,
            count(*) OVER () AS total_rows
       FROM recon_items i
       LEFT JOIN payments p ON p.id = i.payment_row_id
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN vehicles v ON p.raw ? 'vehicle_id' AND v.id::text = p.raw->>'vehicle_id'
       LEFT JOIN admin_users ra ON ra.id = i.reviewed_by
      WHERE ${w.join(' AND ')}
      ORDER BY (i.result IN ('matched', 'pending')), i.id LIMIT ${limit} OFFSET ${offset}`, args);
  const r = await db.one(`SELECT id, started_at, finished_at, range_from, range_to, status, summary FROM recon_runs WHERE id = $1`, [run]);
  return {
    run: r ? { ...r, id: String(r.id) } : null, total: rows[0] ? Number(rows[0].total_rows) : 0,
    rows: rows.map(({ total_rows, ...x }) => ({ ...x, id: String(x.id), payment_row_id: x.payment_row_id ? String(x.payment_row_id) : null,
      settlement_status: null })),
  };
}

async function review({ id, note, adminId }) {
  const r = await db.one(
    `UPDATE recon_items SET reviewed_at = now(), reviewed_by = $2, review_note = $3 WHERE id = $1
     RETURNING id, run_id, payment_row_id, result`, [Number(id), adminId, String(note || '').slice(0, 1000) || null]);
  return r ? { ok: true, item: r } : { ok: false, message: 'No such item.' };
}

module.exports = { run, runs, items, review, checkOne, RESULTS };
