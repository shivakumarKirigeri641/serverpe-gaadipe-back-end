/**
 * src/site/stats.js — "GaadiPe so far", the public numbers on gaadipe.in
 * (user, 2026-09-30).
 *
 * TOTALS ONLY — never a name, a number plate or a mobile. Our own test numbers
 * (users.is_internal) are left out, and so is anyone who said STOP, so every
 * figure is one we would stand behind if asked.
 *
 * A number below site_stats_min is not sent at all rather than shown small:
 * "3 reports bought" puts people off, and a made-up number is not an option.
 * site_stats_enabled = false hides the whole section.
 *
 * Counted at most every ten minutes — the page is public, the queries are not
 * free, and nobody needs these to the second.
 */

const db = require('../db');
const settings = require('../util/settings');

const TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, value: null };

/* The people behind each figure: real customers, not us — and only those who
   agreed to the Terms (user, 2026-10-09): someone who only said Hi is not a
   customer. agreedSql also leaves out anyone who said STOP. */
const { agreedSql } = require('../admin/consented');
const NOT_STOPPED = 'true';

/*
 * WHICH CHANNEL'S NUMBERS (user, 2026-10-15: "currently serving WhatsApp, give WhatsApp only").
 * site_stats_channel: 'whatsapp' — customers who agreed on WhatsApp and their WhatsApp
 * payments; 'web' — the website's; 'all' — both. Switch it with the site's mode.
 */
async function compute() {
  const channel = String(await settings.get('site_stats_channel', 'all')).toLowerCase();
  const REAL = `u.is_internal = false AND ${agreedSql('u.mobile', { whatsappOnly: channel === 'whatsapp', webOnly: channel === 'web' })}`;
  // A payment's own channel, never the browser it was paid in (2026-10-16, migration 191).
  const PAID_CH = channel === 'whatsapp' ? `AND coalesce(nullif(p.raw->>'channel', ''), 'whatsapp') <> 'web'`
    : channel === 'web' ? `AND coalesce(nullif(p.raw->>'channel', ''), 'whatsapp') = 'web'` : '';
  const row = await db.one(`
    WITH checked AS (
      SELECT uv.vehicle_id, uv.check_count
        FROM user_vehicles uv JOIN users u ON u.id = uv.user_id
       WHERE ${REAL}
    ), vehicles_checked AS (
      SELECT DISTINCT v.id, v.reg_no, v.insurance_upto, v.pucc_upto
        FROM vehicles v JOIN checked c ON c.vehicle_id = v.id
    )
    SELECT
      (SELECT count(*) FROM users u WHERE ${REAL} AND ${NOT_STOPPED})::int                AS customers,
      (SELECT count(*) FROM vehicles_checked)::int                                          AS vehicles,
      (SELECT coalesce(sum(check_count), 0) FROM checked)::int                              AS checks,
      (SELECT count(*) FROM api_calls a ${channel === 'all' ? 'LEFT ' : ''}JOIN users u ON u.id = a.user_id
        WHERE NOT a.cache_hit AND a.ok AND ${channel === 'all' ? 'coalesce(u.is_internal, false) = false' : REAL})::int AS records_fetched,
      (SELECT count(*) FROM payments p JOIN users u ON u.id = p.user_id
        WHERE p.status = 'paid' AND p.amount_paise > 0 AND (p.raw->>'test_mode') IS NULL ${PAID_CH} AND ${REAL})::int AS reports_bought,
      (SELECT count(*) FROM subscriptions s JOIN users u ON u.id = s.user_id
        WHERE s.is_active AND s.ends_on >= CURRENT_DATE AND ${REAL})::int                   AS watching,
      (SELECT count(*) FROM vehicles_checked
        WHERE insurance_upto < CURRENT_DATE OR pucc_upto < CURRENT_DATE)::int               AS expired_found,
      (SELECT coalesce(sum(CASE WHEN s.data->>'pending_count' ~ '^[0-9]+$'
                                THEN (s.data->>'pending_count')::int ELSE 0 END), 0)
         FROM vehicle_snapshots s JOIN vehicles_checked vc ON vc.id = s.vehicle_id
        WHERE s.dataset = 'challan')::int                                                   AS challans_found,
      (SELECT count(DISTINCT upper(left(reg_no, 2))) FROM vehicles_checked)::int            AS states`);
  return row;
}

/** The figures worth showing, or null when the section is off or has nothing. */
async function get() {
  if (!(await settings.bool('site_stats_enabled', true))) return null;
  if (!cache.value || Date.now() - cache.at > TTL_MS) {
    cache = { at: Date.now(), value: await compute() };
  }
  const min = await settings.num('site_stats_min', 10);
  // States and UTs are a small number by nature; three already says "across India".
  const floor = { states: 3 };
  const out = {};
  for (const [k, v] of Object.entries(cache.value)) {
    if (Number(v) >= (floor[k] ?? min)) out[k] = Number(v);
  }
  /* THE LATEST HUNDRED (user, 2026-10-16: "every increment of 100 customers, a celebration
     animation" — "always, for any visitor, once on landing"). 100, 200, 300 … reached; the
     home page celebrates it. site_milestone_enabled = false turns it off. */
  const c = Number(cache.value.customers || 0);
  if (c >= 100 && await settings.bool('site_milestone_enabled', true)) out.milestone = Math.floor(c / 100) * 100;
  return Object.keys(out).length ? { ...out, as_of: new Date(cache.at).toISOString() } : null;
}

module.exports = { get, compute };
