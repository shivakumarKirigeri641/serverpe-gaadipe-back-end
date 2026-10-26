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

/* --agreed (user, 2026-10-24: "agreed mobile numbers, oldest to newest"): everyone who agreed to the Terms
   (consent_accepted, on WhatsApp or the website), opted in to offers or not. */
const agreed = process.argv.includes('--agreed');
/* --latest (user, 2026-10-26: the plans SMS goes to the warmest first): newest customer first. */
const latest = process.argv.includes('--latest');
const limit = Math.min(Math.max(parseInt(process.argv.find((a) => /^\d+$/.test(a)), 10) || (agreed ? 1000 : 30), 1), 5000);

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
        AND ${agreed
    ? `EXISTS (SELECT 1 FROM event_log ac WHERE ac.kind = 'consent_accepted'
                 AND right(regexp_replace(ac.detail->>'mobile', '\\D', '', 'g'), 10) = right(regexp_replace(u.mobile, '\\D', '', 'g'), 10))`
    : 'u.promo_consent_at IS NOT NULL AND u.promo_consent_withdrawn_at IS NULL'}
      ORDER BY ${latest ? 'u.created_at DESC, u.id DESC' : 'u.created_at, u.id'}
      LIMIT $1`, [limit]);
  rows.forEach((r, i) => console.log(
    `${String(i + 1).padStart(3)}. ${r.mobile}  ${r.joined.padEnd(11)}  ${r.paid ? 'paid' : '    '}  `
    + `${r.last_promo ? `last promo ${r.last_promo}` : ''.padEnd(16)}  ${String(r.name).slice(0, 20)}`));
  // The whole pool too, so the batch size can be chosen (2026-10-26: "how many?").
  const pool = await db.one(
    `SELECT count(*) FILTER (WHERE promo_consent_at IS NOT NULL AND promo_consent_withdrawn_at IS NULL)::int AS opted_in,
            count(*)::int AS customers
       FROM users u WHERE u.deactivated_at IS NULL AND u.erased_at IS NULL AND u.mobile IS NOT NULL
        AND NOT coalesce(u.is_internal, false)
        AND EXISTS (SELECT 1 FROM event_log ac WHERE ac.kind = 'consent_accepted'
                      AND right(regexp_replace(ac.detail->>'mobile', '\\D', '', 'g'), 10) = right(regexp_replace(u.mobile, '\\D', '', 'g'), 10))`);
  console.log(`\n${rows.length} ${agreed ? 'agreed' : 'opted-in'} customer(s) listed, ${latest ? 'newest' : 'oldest'} first.`);
  console.log(`Of ${pool.customers} customers who agreed to the Terms, ${pool.opted_in} opted in to offers — only they may get a promotional SMS.`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
