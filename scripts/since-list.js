/**
 * scripts/since-list.js — WHO JOINED SINCE A DATE, OUTSIDE THE 24-HOUR WINDOW (user, 2026-10-27: "from 23rd Oct till
 * today but before 24 hrs, give me mobile numbers - will send monitoring alerts"). Read-only; nothing is sent.
 *
 *   node scripts/since-list.js                 joined from 23 Oct (IST) up to 24 hours ago
 *   node scripts/since-list.js 2026-10-23
 *
 * Same rules as the admin Broadcast list: agreed to the Terms, never said STOP, not blocked, not deactivated. Left
 * out: anyone who wrote in the last 24 hours (a free reply reaches them - no template needed) and anyone with
 * monitoring or a report active now. "offers" = opted in to offers - the only people a MARKETING template may go to.
 *
 * Prints mobile numbers: don't save the output to a file, or delete it after use.
 */
require('dotenv').config();
const db = require('../src/db');

const from = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2] || '') ? process.argv[2] : '2026-10-23';
const ist = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');

(async () => {
  const { rows } = await db.query(
    `SELECT u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name, u.created_at,
            (SELECT v.reg_no FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
              WHERE uv.user_id = u.id AND uv.hidden_at IS NULL ORDER BY uv.last_checked_at DESC NULLS LAST LIMIT 1) AS vehicle,
            (SELECT count(*)::int FROM user_vehicles uv WHERE uv.user_id = u.id AND uv.hidden_at IS NULL) AS vehicles,
            EXISTS (SELECT 1 FROM payments x WHERE x.user_id = u.id AND x.status = 'paid' AND x.amount_paise > 0) AS paid,
            (u.promo_consent_at IS NOT NULL AND u.promo_consent_withdrawn_at IS NULL) AS offers,
            (SELECT max(s.last_inbound_at) FROM whatsapp_sessions s WHERE s.mobile = u.mobile) AS last_msg
       FROM users u
      WHERE u.deactivated_at IS NULL
        AND u.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
        AND u.created_at < now() - interval '24 hours'
        AND EXISTS (SELECT 1 FROM event_log c WHERE c.kind = 'consent_accepted'
                     AND right(regexp_replace(c.detail->>'mobile', '\\D', '', 'g'), 10) = right(u.mobile, 10))
        AND NOT EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE s.mobile = u.mobile AND s.wa_opt_out_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.kind = 'mobile' AND b.value = u.mobile AND b.released_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE s.mobile = u.mobile AND s.last_inbound_at > now() - interval '24 hours')
        AND NOT EXISTS (SELECT 1 FROM vehicle_reports r WHERE r.user_id = u.id AND r.valid_until > now())
        AND NOT EXISTS (SELECT 1 FROM subscriptions sb WHERE sb.user_id = u.id AND sb.is_active AND sb.ends_on >= CURRENT_DATE)
        AND coalesce(u.is_internal, false) = false
      ORDER BY u.created_at`, [from]);

  console.log(`\nJoined from ${from} (IST) up to 24 hours ago - outside the free-reply window, no monitoring active: ${rows.length}\n`);
  console.log('  #   mobile        joined          vehicle (count)       paid  offers  last message');
  rows.forEach((r, i) => console.log(
    `  ${String(i + 1).padStart(3)} ${String(r.mobile).slice(-10)}  ${ist(r.created_at).padEnd(15)} ${`${r.vehicle || '-'}${r.vehicles > 1 ? ` (${r.vehicles})` : ''}`.padEnd(21)} ${r.paid ? 'yes ' : 'no  '}  ${r.offers ? 'yes   ' : 'no    '}  ${ist(r.last_msg)}`));
  const withVeh = rows.filter((r) => r.vehicle).length;
  console.log(`\n  With a vehicle on their list: ${withVeh} · paid before: ${rows.filter((r) => r.paid).length} · opted in to offers: ${rows.filter((r) => r.offers).length}`);
  console.log('\nJust the numbers (with a vehicle):');
  console.log(rows.filter((r) => r.vehicle).map((r) => String(r.mobile).slice(-10)).join(', ') || '  none');
  console.log('\nNothing was sent. Do not keep this output in a file.\n');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
