/**
 * src/admin/home.js — what needs you, and what happened (user, 2026-09-23).
 *
 * The panel had three overviews — Dashboard, Live and Analytics — and none of
 * them answered the question somebody actually opens a panel to ask: is
 * anything wrong, and is anyone waiting on me?
 *
 * So this returns two things and nothing else:
 *
 *   NEEDS YOU   things a person must act on, each with the screen that fixes
 *               it. Ordered by how much it costs to ignore: money that did not
 *               arrive first, a customer waiting second, a setting that is
 *               quietly wrong last.
 *
 *   TODAY       the handful of numbers worth knowing before the first coffee,
 *               each against yesterday so the number means something.
 *
 * NOTHING HERE IS A COUNT FOR ITS OWN SAKE. A number nobody would act on is
 * noise, and a panel full of noise is a panel nobody reads.
 */

const db = require('../db');
const settings = require('../util/settings');
const { config } = require('../config');

/** IST, because "today" is a day in India. */
const IST = "AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'";

/**
 * Everything waiting on a person.
 *
 * Each item carries its own severity and where to go. "Nothing to do" is a
 * real and welcome answer — the screen says so plainly rather than inventing
 * something to show.
 */
async function attention() {
  const items = [];
  const add = (level, title, detail, to) => items.push({ level, title, detail, to });

  const row = await db.one(
    `SELECT
       (SELECT count(*)::int FROM contact_messages WHERE status = 'open')            AS tickets_open,
       (SELECT count(*)::int FROM contact_messages
         WHERE status = 'open' AND created_at < now() - interval '24 hours')         AS tickets_stale,
       (SELECT count(*)::int FROM feedback WHERE created_at > now() - interval '7 days') AS feedback_week,
       (SELECT count(*)::int FROM payments
         WHERE status = 'created' AND created_at > now() - interval '24 hours')      AS payments_stuck,
       (SELECT count(*)::int FROM customer_emails
         WHERE status = 'failed' AND attempts >= 5)                                  AS emails_failed,
       (SELECT count(*)::int FROM whatsapp_broadcast_targets WHERE status = 'failed') AS broadcast_failed,
       (SELECT count(*)::int FROM subscriptions
         WHERE is_active AND ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE + 3)      AS ending_soon,
       (SELECT count(*)::int FROM vehicle_reports
         WHERE created_at > now() - interval '24 hours')                             AS reports_today,
       (SELECT count(*)::int FROM security_events
         WHERE created_at > now() - interval '24 hours')                             AS security_today,
       (SELECT count(*)::int FROM api_calls
         WHERE NOT ok AND created_at > now() - interval '24 hours')                  AS lookups_failed`);

  /* Money that did not arrive. The most expensive thing to not notice. */
  if (row.payments_stuck) {
    add('wrong', `${row.payments_stuck} payment${row.payments_stuck === 1 ? '' : 's'} started but not finished`,
      'Opened in the last 24 hours and never completed. The reconciler recovers a real payment; anything left here was abandoned at the payment page.',
      '/finance');
  }

  /* A customer waiting. */
  if (row.tickets_stale) {
    add('wrong', `${row.tickets_stale} support ticket${row.tickets_stale === 1 ? '' : 's'} older than a day`,
      'Somebody wrote in and has not heard back.', '/tickets');
  } else if (row.tickets_open) {
    add('watch', `${row.tickets_open} open support ticket${row.tickets_open === 1 ? '' : 's'}`,
      'Waiting for an answer.', '/tickets');
  }

  /* Things that tried to reach a customer and failed. */
  if (row.emails_failed) {
    add('wrong', `${row.emails_failed} customer email${row.emails_failed === 1 ? '' : 's'} gave up`,
      'Tried five times and stopped. Usually a bad address or a mail server refusing us.', '/campaigns');
  }
  if (row.broadcast_failed) {
    add('watch', `${row.broadcast_failed} broadcast message${row.broadcast_failed === 1 ? '' : 's'} failed`,
      'Meta refused these. The reason is against each recipient.', '/campaigns');
  }

  /* Money that could arrive, if somebody acts. */
  if (row.ending_soon) {
    add('watch', `${row.ending_soon} customer${row.ending_soon === 1 ? '' : 's'} lose monitoring within 3 days`,
      'The renewal notice goes out automatically. Worth knowing who they are.', '/customers');
  }

  /* The upstream service. */
  if (row.lookups_failed) {
    add('watch', `${row.lookups_failed} vehicle lookup${row.lookups_failed === 1 ? '' : 's'} failed today`,
      'A customer asked and got nothing back. Check whether ULIP is refusing us.', '/health');
  }
  if (row.security_today) {
    add('info', `${row.security_today} security event${row.security_today === 1 ? '' : 's'} today`,
      'Refused requests, rate limits, wrong passcodes.', '/security');
  }

  /*
   * Settings that are quietly wrong. Cheap to fix, expensive to leave: every
   * one of these means customers are silently not being reached.
   */
  const onlyTo = String(await settings.get('customer_email_only_to', '') || '').trim();
  if (onlyTo) {
    add('info', 'Customer email is in test mode',
      `Only ${onlyTo} receives anything. Every other customer is recorded as skipped.`, '/campaigns');
  }
  if (!config.whatsapp.enabled) {
    add('info', 'WhatsApp is switched off',
      'The bot, alerts and broadcasts are all inert until WHATSAPP_ENABLED=1 and the gateway restarts.', '/health');
  } else if (config.whatsapp.allowedRecipients.length) {
    add('info', 'WhatsApp is in test mode',
      `Only ${config.whatsapp.allowedRecipients.join(', ')} can receive a message.`, '/health');
  }

  return { items, counts: row };
}

/** The numbers worth seeing first, each against the day before. */
async function today() {
  return db.one(
    `WITH b AS (
       SELECT date_trunc('day', now() ${IST}) AS today,
              date_trunc('day', now() ${IST}) - interval '1 day' AS yesterday
     )
     SELECT
       (SELECT count(*)::int FROM users u, b WHERE u.created_at ${IST} >= b.today)        AS signed_up,
       (SELECT count(*)::int FROM users u, b
         WHERE u.created_at ${IST} >= b.yesterday AND u.created_at ${IST} < b.today)      AS signed_up_before,
       (SELECT count(*)::int FROM event_log e, b
         WHERE e.kind = 'vehicle_check' AND e.created_at ${IST} >= b.today)               AS checks,
       (SELECT count(*)::int FROM event_log e, b
         WHERE e.kind = 'vehicle_check' AND e.created_at ${IST} >= b.yesterday
           AND e.created_at ${IST} < b.today)                                             AS checks_before,
       (SELECT count(*)::int FROM payments p, b
         WHERE p.status = 'paid' AND p.amount_paise > 0 AND p.paid_at ${IST} >= b.today)  AS paid,
       (SELECT count(*)::int FROM payments p, b
         WHERE p.status = 'paid' AND p.amount_paise > 0
           AND p.paid_at ${IST} >= b.yesterday AND p.paid_at ${IST} < b.today)            AS paid_before,
       (SELECT coalesce(sum(amount_paise), 0)::int FROM payments p, b
         WHERE p.status = 'paid' AND p.paid_at ${IST} >= b.today)                         AS earned_paise,
       (SELECT coalesce(sum(amount_paise), 0)::int FROM payments p, b
         WHERE p.status = 'paid'
           AND p.paid_at ${IST} >= b.yesterday AND p.paid_at ${IST} < b.today)            AS earned_before_paise,
       (SELECT count(*)::int FROM subscriptions
         WHERE is_active AND ends_on >= CURRENT_DATE)                                     AS monitoring,
       (SELECT count(*)::int FROM users)                                                  AS customers,
       (SELECT count(*)::int FROM vehicles)                                               AS vehicles`);
}

/**
 * How far people got today, and where they stopped.
 *
 * The same shape as the funnel screen, but for one day and unlabelled — the
 * point here is the shape, not the analysis.
 */
async function funnelToday() {
  const row = await db.one(
    `WITH b AS (SELECT date_trunc('day', now() ${IST}) AS today)
     SELECT
       (SELECT count(DISTINCT s.user_id)::int FROM site_sessions s, b
         WHERE s.created_at ${IST} >= b.today)                                   AS arrived,
       (SELECT count(DISTINCT a.user_id)::int FROM site_activity a, b
         WHERE a.created_at ${IST} >= b.today
           AND a.action IN ('check', 'view_vehicle', 'view_vehicle_paid'))       AS checked,
       (SELECT count(DISTINCT a.user_id)::int FROM site_activity a, b
         WHERE a.created_at ${IST} >= b.today AND a.action = 'buy_open')         AS opened_buy,
       (SELECT count(DISTINCT a.user_id)::int FROM site_activity a, b
         WHERE a.created_at ${IST} >= b.today AND a.action = 'pay_start')        AS tapped_pay,
       (SELECT count(DISTINCT p.user_id)::int FROM payments p, b
         WHERE p.status = 'paid' AND p.amount_paise > 0 AND p.paid_at ${IST} >= b.today) AS paid`);
  return [
    { step: 'Arrived', n: row.arrived },
    { step: 'Checked a vehicle', n: row.checked },
    { step: 'Opened Buy', n: row.opened_buy },
    { step: 'Tapped Pay', n: row.tapped_pay },
    { step: 'Paid', n: row.paid },
  ];
}

/** The last fourteen days, for the one chart worth having on a home screen. */
async function recent() {
  const { rows } = await db.query(
    `WITH days AS (
       SELECT generate_series(
         date_trunc('day', now() ${IST}) - interval '13 days',
         date_trunc('day', now() ${IST}), interval '1 day') AS d
     )
     SELECT to_char(days.d, 'DD Mon')                                            AS label,
            (SELECT count(*)::int FROM users u
              WHERE u.created_at ${IST} >= days.d AND u.created_at ${IST} < days.d + interval '1 day') AS signed_up,
            (SELECT count(*)::int FROM event_log e
              WHERE e.kind = 'vehicle_check'
                AND e.created_at ${IST} >= days.d AND e.created_at ${IST} < days.d + interval '1 day') AS checks,
            (SELECT count(*)::int FROM payments p
              WHERE p.status = 'paid' AND p.amount_paise > 0
                AND p.paid_at ${IST} >= days.d AND p.paid_at ${IST} < days.d + interval '1 day')       AS paid
       FROM days ORDER BY days.d`);
  return rows;
}

/** Who is here right now — the chat and the website both. */
async function liveNow() {
  const row = await db.one(
    `SELECT
       (SELECT count(*)::int FROM site_sessions
         WHERE ended_at IS NULL AND last_used_at > now() - interval '5 minutes')  AS on_site,
       (SELECT count(*)::int FROM whatsapp_sessions
         WHERE modified_at > now() - interval '30 minutes')                       AS in_chat,
       (SELECT count(*)::int FROM whatsapp_messages
         WHERE created_at > now() - interval '24 hours')                          AS messages_today`);
  return { ...row, whatsapp_on: config.whatsapp.enabled };
}

async function everything() {
  const [a, t, f, r, l] = await Promise.all([attention(), today(), funnelToday(), recent(), liveNow()]);
  return { attention: a.items, today: t, funnel: f, recent: r, live: l };
}

module.exports = { everything, attention, today, funnelToday, recent, liveNow };
