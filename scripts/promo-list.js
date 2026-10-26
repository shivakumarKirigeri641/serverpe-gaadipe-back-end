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
/* --service (user, 2026-10-26: "send to 400+ people that I am on WhatsApp now"): for a SERVICE SMS - everyone who
   agreed to the Terms, except anyone who said STOP on WhatsApp, anyone texted in the last 7 days, and the promo
   opt-ins (they got the plans SMS with gaadipe.in/wa from Fast2SMS directly on 26 Oct, which GaadiPe has no
   record of). Never for offers or prices: those go only to the opt-ins. */
const service = process.argv.includes('--service');
const agreed = service || process.argv.includes('--agreed');
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
        ${service ? `AND NOT EXISTS (SELECT 1 FROM whatsapp_sessions so WHERE right(so.mobile, 10) = right(u.mobile, 10)
                                         AND so.wa_opt_out_at IS NOT NULL)
                     AND NOT (u.promo_consent_at IS NOT NULL AND u.promo_consent_withdrawn_at IS NULL)
                     AND NOT EXISTS (SELECT 1 FROM notify_log nl WHERE nl.user_id = u.id AND nl.channel = 'sms'
                                       AND nl.status IN ('sent', 'simulated') AND nl.created_at > now() - interval '7 days')` : ''}
      ORDER BY ${latest ? 'u.created_at DESC, u.id DESC' : 'u.created_at, u.id'}
      LIMIT $1`, [limit]);
  /* --numbers (2026-10-26: "give me proper ones", "line by line"): only the numbers, one per line, to paste into
     Fast2SMS. */
  if (process.argv.includes('--numbers')) {
    console.log(rows.map((r) => r.mobile).join('\n'));
    console.error(`(${rows.length} numbers, ${latest ? 'newest' : 'oldest'} first — delete any copy after use)`);
    process.exit(0);
  }
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
  console.log(`\n${rows.length} ${service ? 'service-SMS' : agreed ? 'agreed' : 'opted-in'} customer(s) listed, ${latest ? 'newest' : 'oldest'} first.`
    + (service ? ' (No STOP, no promo opt-ins, nobody texted in the last 7 days.)' : ''));
  console.log(`Of ${pool.customers} customers who agreed to the Terms, ${pool.opted_in} opted in to offers — only they may get a promotional SMS.`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
