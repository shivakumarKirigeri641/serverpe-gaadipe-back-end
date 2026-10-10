/**
 * src/site/subscriptions.js — MY SUBSCRIPTIONS in the chat (user, 2026-10-10: "how
 * many can check, next expiry date, next alert date & time and more").
 *
 * Every vehicle this customer monitors (paid 28 days, or the free 14), plus ones
 * that ended in the last 30 days (with the renewal price), each with:
 *   plan, started, ends (and days left), the PDF's download window,
 *   the next document to expire and its date,
 *   the next alert — a document warning (expiry_warn_days 30/7/1) or the
 *   "monitoring ends" notice — on its day, sent from alert_send_hour_ist (7 pm),
 *   when GaadiPe next checks it for new challans,
 *   and what renewing costs (₹11 within the renewal window, else ₹19).
 * And the checks left today and this month.
 */

const db = require('../db');
const settings = require('../util/settings');

const DOCS = [['insurance_upto', 'Insurance'], ['pucc_upto', 'PUC'], ['tax_upto', 'Road tax'], ['fitness_upto', 'Fitness'], ['permit_upto', 'Permit']];
const dayOnly = (d) => new Date(new Date(d).toISOString().slice(0, 10));

async function forUser(userId) {
  const warn = String(await settings.get('expiry_warn_days', '30,7,1')).split(',').map(Number).filter((x) => x > 0).sort((a, b) => b - a);
  const renewalDays = await settings.num('renewal_notice_days', 3);
  const freeDays = await settings.num('free_monitor_notice_days', 2);
  const sendHour = await settings.num('alert_send_hour_ist', 19);
  const { rows } = await db.query(
    `SELECT DISTINCT ON (w.vehicle_id) w.id, w.vehicle_id, w.subscription_id, w.is_active, w.created_at, w.expires_at,
            least(w.challan_next_check_at, w.rc_next_check_at) AS next_check_at, w.last_checked_at,
            v.reg_no, v.maker, v.model, v.insurance_upto, v.pucc_upto, v.tax_upto, v.fitness_upto, v.permit_upto,
            (SELECT max(r.valid_until) FROM vehicle_reports r WHERE r.user_id = w.user_id AND r.reg_no = v.reg_no) AS report_until
       FROM watches w JOIN vehicles v ON v.id = w.vehicle_id
      WHERE w.user_id = $1 AND (w.is_active OR w.expires_at > now() - interval '30 days')
        AND NOT EXISTS (SELECT 1 FROM user_vehicles uv WHERE uv.user_id = w.user_id AND uv.vehicle_id = w.vehicle_id AND uv.hidden_at IS NOT NULL)
      ORDER BY w.vehicle_id, w.is_active DESC, w.expires_at DESC`, [userId]);
  const today = dayOnly(new Date(Date.now() + 5.5 * 3600e3));
  const billing = require('../pay/billing');
  const out = [];
  for (const r of rows) {
    const active = r.is_active && (!r.expires_at || new Date(r.expires_at) > new Date());
    const paid = Boolean(r.subscription_id);
    // The next document to run out.
    // doc: the column's key, so the chat words it in the customer's language.
    const docs = DOCS.filter(([k]) => r[k]).map(([k, label]) => ({ doc: k, label, date: dayOnly(r[k]) })).sort((a, b) => a.date - b.date);
    const nextDoc = docs.find((d) => d.date >= today) || null;
    // The next alert: the earliest warning day still ahead, or the "monitoring ends" notice.
    const alerts = [];
    if (active) {
      for (const d of docs) {
        for (const t of warn) {
          const at = new Date(d.date.getTime() - t * 86400e3);
          // Only while monitoring still runs — a warning due after it ends is never sent.
          if (at >= today && (!r.expires_at || at <= new Date(r.expires_at))) { alerts.push({ at, kind: 'expiry', doc: d.doc, days: t, what: `${d.label} expires in ${t} day${t === 1 ? '' : 's'}` }); break; }
        }
      }
      if (r.expires_at) {
        const at = dayOnly(new Date(new Date(r.expires_at).getTime() - (paid ? renewalDays : freeDays) * 86400e3));
        if (at >= today) alerts.push({ at, kind: 'ending', what: 'Monitoring ends soon — renew reminder' });
      }
    }
    alerts.sort((a, b) => a.at - b.at);
    const next = alerts[0] || null;
    const priced = await billing.reportPriceFor(userId, r.vehicle_id).catch(() => null);
    out.push({
      reg_no: r.reg_no, maker: r.maker, model: r.model,
      plan: paid ? 'paid' : 'free', active,
      started_at: r.created_at, ends_at: r.expires_at,
      days_left: active && r.expires_at ? Math.max(0, Math.ceil((new Date(r.expires_at) - Date.now()) / 86400e3)) : null,
      report_until: r.report_until && new Date(r.report_until) > new Date() ? r.report_until : null,
      // Stopped before its end date (removed, or switched off) — not "ended".
      stopped: !active && Boolean(r.expires_at) && new Date(r.expires_at) > new Date(),
      next_document: nextDoc ? { doc: nextDoc.doc, label: nextDoc.label, date: nextDoc.date.toISOString().slice(0, 10) } : null,
      next_alert: next ? { date: next.at.toISOString().slice(0, 10), from_hour: sendHour, kind: next.kind, doc: next.doc || null, days: next.days || null, what: next.what } : null,
      next_check_at: active ? r.next_check_at : null,
      last_checked_at: r.last_checked_at,
      renew_paise: priced?.paise ?? null, renewal: Boolean(priced?.renewal),
    });
  }
  out.sort((a, b) => (b.active - a.active) || (new Date(a.ends_at) - new Date(b.ends_at)));
  return { rows: out, checks: await require('../util/quota').left(userId).catch(() => null) };
}

module.exports = { forUser };
