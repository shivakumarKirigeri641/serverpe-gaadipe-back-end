/**
 * src/admin/attribution.js — Campaigns & Attribution (user, 2026-09-25,
 * operations module phase 3).
 * ---------------------------------------------------------------------------
 *   overview(q)  per source, or per campaign within one: visitors, WhatsApp
 *                starts, vehicle searches, lookups, payment attempts,
 *                payments, revenue, GST, API, gateway, net, conversion —
 *                by first touch (default) or last touch
 *   people(q)    the customers behind one source / campaign, for drill-down:
 *                campaign → customer → journey → vehicle → payment
 *
 * Every person is credited to one source: the first (or last) touch GaadiPe
 * recorded for them — the website visit's UTM / referrer, a WhatsApp ad —
 * else "Direct on WhatsApp" when they simply wrote. First touch is never
 * overwritten (src/events/track.js keeps it). The money is the ledger's.
 * No ad spend is recorded, so there is no CAC or ROAS (user, 2026-09-25);
 * referral cost is ₹0 (no referral programme).
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const command = require('./command');
const ledger = require('../finance/ledger');

const WORD = { direct: 'Direct', google_ads: 'Google Ads', meta_ads: 'Meta Ads', google: 'Google (organic)', organic: 'Organic search',
  social: 'Social', whatsapp: 'WhatsApp', referral: 'Referring site', whatsapp_direct: 'Direct on WhatsApp', website_signup: 'Website sign-up' };
/* The spec's source families. */
const FAMILY = (s) => ({ google_ads: 'Google Ads', meta_ads: 'Social', social: 'Social', google: 'Organic', organic: 'Organic', direct: 'Direct',
  whatsapp: 'WhatsApp', whatsapp_direct: 'WhatsApp', referral: 'Other', website_signup: 'Direct' }[s] || 'Other');

/* Each customer's credited touch. */
async function credits(model) {
  const { rows } = await db.query(
    `SELECT u.id, u.mobile, u.signup_channel, ws.attribution,
            (SELECT v.first_touch FROM visitors v WHERE v.user_id = u.id OR v.mobile = u.mobile ORDER BY v.first_seen_at LIMIT 1) AS v_first,
            (SELECT v.last_touch FROM visitors v WHERE v.user_id = u.id OR v.mobile = u.mobile ORDER BY v.last_seen_at DESC LIMIT 1) AS v_last
       FROM users u
       LEFT JOIN LATERAL (SELECT s.attribution FROM whatsapp_sessions s WHERE s.user_id = u.id OR s.mobile = u.mobile ORDER BY s.id DESC LIMIT 1) ws ON true`);
  const m = new Map();
  for (const x of rows) {
    const a = x.attribution || {};
    let t = model === 'last' ? (a.last_touch || x.v_last || a.first_touch || x.v_first) : (a.first_touch || x.v_first);
    if (!t?.source && a.channel === 'whatsapp_ad') t = { source: 'meta_ads', campaign: a.headline || a.source_id || null };
    if (!t?.source) t = { source: x.signup_channel === 'web' ? 'website_signup' : 'whatsapp_direct' };
    m.set(String(x.id), { source: t.source, medium: t.medium || null, campaign: t.campaign || null, term: t.term || null, content: t.content || null, mobile: x.mobile });
  }
  return m;
}

async function overview(q = {}) {
  const r = command.resolve({ range: q.range || '30d', from: q.from, to: q.to, compare: 'none' });
  const model = q.model === 'last' ? 'last' : 'first';
  const within = q.source || null;          // campaigns inside one source
  const [credit, visitors, ev, pays, money] = await Promise.all([
    credits(model),
    db.query(`SELECT visitor_id, user_id, first_touch, last_touch FROM visitors WHERE first_seen_at >= $1 AND first_seen_at < $2`, [r.from, r.to]),
    db.query(`SELECT e.user_id, u.id AS uid, e.name, count(*)::int AS n
                FROM events e LEFT JOIN users u ON u.id = e.user_id OR (e.user_id IS NULL AND e.mobile IS NOT NULL AND u.mobile = e.mobile)
               WHERE e.occurred_at >= $1 AND e.occurred_at < $2
                 AND e.name IN ('whatsapp_chat_started', 'whatsapp_vehicle_received', 'vehicle_search_success', 'vehicle_search_failed')
               GROUP BY 1, 2, 3`, [r.from, r.to]),
    db.query(`SELECT user_id, count(*)::int AS n FROM payments WHERE created_at >= $1 AND created_at < $2 AND amount_paise > 0
                AND coalesce(gateway, '') <> 'free' AND NOT (raw ? 'free') GROUP BY 1`, [r.from, r.to]),
    ledger.entries({ from: r.from, to: r.to }),
  ]);
  const key = (c) => (within ? (c.campaign || '(no campaign)') : c.source);
  const rows = new Map();
  const at = (c) => {
    if (within && c.source !== within) return null;
    const k = key(c);
    if (!rows.has(k)) rows.set(k, { key: k, label: within ? k : (WORD[k] || k), family: within ? null : FAMILY(k), visitors: 0, customers: new Set(), payers: new Set(),
      wa_starts: 0, searches: 0, lookups: 0, attempts: 0, payments: 0, revenue_paise: 0, gst_paise: 0, api_cost_paise: 0,
      gateway_paise: 0, whatsapp_cost_paise: 0, net_paise: 0 });
    return rows.get(k);
  };
  for (const v of visitors.rows) {
    const t = (model === 'last' ? v.last_touch : v.first_touch) || v.first_touch || {};
    const c = v.user_id && credit.get(String(v.user_id)) ? credit.get(String(v.user_id)) : { source: t.source || 'direct', campaign: t.campaign || null };
    const g = at(c); if (g) g.visitors += 1;
  }
  for (const e of ev.rows) {
    const id = e.user_id || e.uid; const c = id ? credit.get(String(id)) : null;
    if (!c) continue;
    const g = at(c); if (!g) continue;
    g.customers.add(String(id));
    if (e.name === 'whatsapp_chat_started') g.wa_starts += e.n;
    else if (e.name === 'whatsapp_vehicle_received') g.searches += e.n;
    else g.lookups += e.n;
  }
  for (const p of pays.rows) { const c = p.user_id ? credit.get(String(p.user_id)) : null; const g = c && at(c); if (g) g.attempts += p.n; }
  for (const x of money.rows) {
    const c = x.user_id ? credit.get(x.user_id) : null; const g = c && at(c); if (!g) continue;
    if (x.kind === 'paid') { g.payments += 1; g.payers.add(x.user_id); }
    g.revenue_paise += x.gross_paise; g.gst_paise += x.gst_paise; g.api_cost_paise += x.api_cost_paise;
    g.gateway_paise += x.gateway_fee_paise + x.gateway_gst_paise; g.whatsapp_cost_paise += x.whatsapp_cost_paise; g.net_paise += x.net_paise;
    g.customers.add(x.user_id);
  }
  const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const out = [...rows.values()].map((g) => ({
    ...g, customers: g.customers.size, payers: g.payers.size,
    // Paying customers out of the people who arrived — never payments ÷ people.
    conversion_pct: rate(g.payers.size, g.visitors || g.customers.size),
    conversion_base: g.visitors ? 'visitors' : 'customers',
    cac_paise: null, roas: null,
  })).sort((a, b) => b.revenue_paise - a.revenue_paise || b.visitors - a.visitors);
  return {
    range: { label: r.label }, model, source: within, source_label: within ? (WORD[within] || within) : null, rows: out,
    notes: {
      model: model === 'first' ? 'Each customer is credited to the first touch GaadiPe recorded — never overwritten.' : 'Each customer is credited to the latest touch GaadiPe recorded.',
      spend: 'No ad spend is recorded, so customer acquisition cost and ROAS are not shown.',
      referral: 'Referral cost: ₹0 — no referral programme for now.',
      net: 'Net: revenue less GST, the gateway, and the API and WhatsApp cost tied to each payment (ledger).',
    },
  };
}

/* The customers behind a source (and campaign): campaign → customer → journey. */
async function people(q = {}) {
  const model = q.model === 'last' ? 'last' : 'first';
  const credit = await credits(model);
  const ids = [...credit.entries()].filter(([, c]) => c.source === q.source && (!q.campaign || (c.campaign || '(no campaign)') === q.campaign)).map(([id]) => Number(id));
  if (!ids.length) return { rows: [] };
  const { rows } = await db.query(
    `SELECT u.id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.created_at,
            (SELECT count(*) FROM payments p WHERE p.user_id = u.id AND p.status IN ('paid', 'refunded') AND p.amount_paise > 0)::int AS paid,
            (SELECT coalesce(sum(p.amount_paise), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid')::bigint AS revenue_paise,
            (SELECT (array_agg(e.reg_no ORDER BY e.occurred_at DESC) FILTER (WHERE e.reg_no IS NOT NULL))[1] FROM events e WHERE e.user_id = u.id) AS last_reg,
            (SELECT max(e.occurred_at) FROM events e WHERE e.user_id = u.id) AS last_active
       FROM users u WHERE u.id = ANY($1::bigint[]) ORDER BY 6 DESC NULLS LAST LIMIT 200`, [ids]);
  return { rows: rows.map((x) => ({ ...x, id: String(x.id), revenue_paise: Number(x.revenue_paise), touch: credit.get(String(x.id)) })) };
}

module.exports = { overview, people, WORD };
