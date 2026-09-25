/**
 * src/admin/whatsappOps.js — WhatsApp's money (user, 2026-09-25, operations
 * module phase 4). The WhatsApp Center (whatsappStats.js) already counts
 * messages, receipts, blocks and the chat's funnel; this adds what it costs
 * and what it brings in, for today, yesterday, 7 and 30 days:
 *   templates by Meta category (MARKETING / UTILITY / AUTHENTICATION) and
 *   their cost; user- and business-initiated conversations; WhatsApp revenue
 *   (the ledger's payments whose conversion channel is WhatsApp), cost and
 *   contribution; cost per paying customer and per report delivered.
 *
 * Meta's invoice is not imported, so each category's cost per message is a
 * setting (whatsapp_cost_paise_marketing / _utility / _authentication, else
 * whatsapp_message_cost_paise) and every figure says it is an estimate.
 * Replies inside the customer's 24-hour window are free and cost ₹0.
 */

const db = require('../db');
const command = require('./command');
const settings = require('../util/settings');
const ledger = require('../finance/ledger');

async function rates() {
  const base = await settings.num('whatsapp_message_cost_paise', 11);
  return {
    MARKETING: await settings.num('whatsapp_cost_paise_marketing', base),
    UTILITY: await settings.num('whatsapp_cost_paise_utility', base),
    AUTHENTICATION: await settings.num('whatsapp_cost_paise_authentication', base),
    OTHER: base,
  };
}

async function windowFigures(from, to, R) {
  const [cat, conv, money, delivered] = await Promise.all([
    db.query(`SELECT coalesce(upper(t.category), 'OTHER') AS category, count(*)::int AS n
                FROM whatsapp_messages m LEFT JOIN wa_templates t ON t.template_name = m.template_name
               WHERE m.direction = 'out' AND m.message_type = 'template' AND m.created_at >= $1 AND m.created_at < $2
               GROUP BY 1`, [from, to]),
    db.one(`SELECT count(DISTINCT (mobile, (created_at AT TIME ZONE 'Asia/Kolkata')::date)) FILTER (WHERE direction = 'in')::int AS user_initiated,
                   count(*) FILTER (WHERE direction = 'out' AND message_type = 'template')::int AS business_initiated,
                   count(DISTINCT mobile) FILTER (WHERE direction = 'in')::int AS users,
                   count(*) FILTER (WHERE direction = 'in')::int AS received,
                   count(*) FILTER (WHERE direction = 'out')::int AS sent
              FROM whatsapp_messages WHERE created_at >= $1 AND created_at < $2`, [from, to]),
    ledger.entries({ from, to }),
    db.one(`SELECT count(*)::int AS n FROM events WHERE name = 'report_delivered' AND channel = 'whatsapp' AND occurred_at >= $1 AND occurred_at < $2`, [from, to]),
  ]);
  const categories = cat.rows.map((c) => ({ category: c.category, messages: c.n, rate_paise: R[c.category] ?? R.OTHER, cost_paise: c.n * (R[c.category] ?? R.OTHER) }));
  const cost = categories.reduce((s, c) => s + c.cost_paise, 0);
  const wa = money.rows.filter((x) => x.channel === 'whatsapp');
  const t = ledger.total(wa);
  const payers = new Set(wa.filter((x) => x.kind === 'paid').map((x) => x.user_id)).size;
  return {
    ...conv, categories, cost_paise: cost,
    revenue_paise: t.gross_paise, net_revenue_paise: t.net_revenue_paise,
    // Contribution before the records API: what WhatsApp sales leave after GST, the gateway and WhatsApp itself.
    contribution_paise: t.net_revenue_paise - t.gateway_paise - cost,
    payments: t.payments, payers, reports_delivered: delivered.n,
    cost_per_paying_customer_paise: payers ? Math.round(cost / payers) : null,
    cost_per_report_paise: delivered.n ? Math.round(cost / delivered.n) : null,
  };
}

async function economics() {
  const R = await rates();
  const windows = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']];
  const out = [];
  for (const [range, label] of windows) {
    const r = command.resolve({ range, compare: 'none' });
    out.push({ range, label, ...(await windowFigures(r.from, r.to, R)) });
  }
  return {
    windows: out, rates: R,
    notes: {
      estimate: 'Costs are estimates at the per-category rates in Settings — Meta’s invoice is not imported. Replies inside the 24-hour window are free.',
      contribution: 'WhatsApp contribution: WhatsApp-channel revenue after GST and the gateway, less the cost of business-initiated messages. The records API is not in it.',
      conversations: 'User-initiated: days on which a person wrote. Business-initiated: templates GaadiPe sent.',
    },
  };
}

module.exports = { economics };
