/**
 * scripts/promo-list.js — WHO MAY GET A PROMOTIONAL SMS, oldest customer first (user, 2026-10-24: "give me mobile
 * numbers sorted oldest to newest 30"). Read-only; sends nothing.
 *
 *   node scripts/promo-list.js          the first 30
 *   node scripts/promo-list.js 50       the first 50
 *
 * Opted in to offers (promo_consent_at, not withdrawn) — the same rule as the SMS broadcast's Promo mode — not
 * deactivated or erased, not GaadiPe's own numbers. "last promo" is the last promotional or service SMS sent to
 * them: skip anyone who got one in the past week.
 */
require('dotenv').config();
const db = require('../src/db');

const limit = Math.min(Math.max(parseInt(process.argv[2], 10) || 30, 1), 500);

(async () => {
  const { rows } = await db.query(
    `SELECT right(regexp_replace(u.mobile, '\\D', '', 'g'), 10) AS mobile,
            coalesce(u.display_name, u.wa_profile_name, u.name, '') AS name,
            to_char(u.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY') AS joined,
            EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0) AS paid,
            to_char((SELECT max(nl.created_at) FROM notify_log nl WHERE nl.user_id = u.id AND nl.channel = 'sms'
                       AND nl.kind IN ('promo', 'service') AND nl.status IN ('sent', 'simulated'))
                    AT TIME ZONE 'Asia/Kolkata', 'DD Mon') AS last_promo
       FROM users u
      WHERE u.deactivated_at IS NULL AND u.erased_at IS NULL AND u.mobile IS NOT NULL
        AND NOT coalesce(u.is_internal, false)
        AND u.promo_consent_at IS NOT NULL AND u.promo_consent_withdrawn_at IS NULL
      ORDER BY u.created_at, u.id
      LIMIT $1`, [limit]);
  rows.forEach((r, i) => console.log(
    `${String(i + 1).padStart(3)}. ${r.mobile}  ${r.joined.padEnd(11)}  ${r.paid ? 'paid' : '    '}  `
    + `${r.last_promo ? `last promo ${r.last_promo}` : ''.padEnd(16)}  ${String(r.name).slice(0, 20)}`));
  console.log(`\n${rows.length} opted-in customer(s), oldest first.`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
