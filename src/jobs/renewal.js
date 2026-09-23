/**
 * src/jobs/renewal.js — telling someone their monitoring is about to end
 * (user, 2026-09-23).
 *
 * Monitoring runs 28 days and then stops, both halves of it: new challans and
 * the document-expiry warnings. Three days before the end (renewal_notice_days)
 * the customer is told, once, and offered the same vehicle for ₹9 + GST instead
 * of ₹19.
 *
 * WHY THREE DAYS AND NOT ON THE DAY. On the last day there is nothing to
 * decide — it has already stopped being useful. Three days is long enough to
 * think and short enough that the service is still fresh in mind.
 *
 * ONCE PER SUBSCRIPTION, not once per pass. The reminder is recorded in
 * event_log against the subscription id before it is sent, so a job that runs
 * hourly for three days sends one message rather than seventy-two.
 *
 * NOTHING RENEWS AUTOMATICALLY. GaadiPe has never taken a second payment
 * without being asked and this does not change that: the message carries a
 * link, and the customer decides. That promise is in the terms.
 */

const db = require('../db');
const settings = require('../util/settings');
const billing = require('../pay/billing');
const C = require('../mail/customer');
const T = require('../mail/templates');
const { config } = require('../config');

const istDay = C.istDay;

/*
 * A date column, spelled the way Postgres spells it.
 *
 * node-pg hands a `date` back as a Date at LOCAL midnight, so toISOString()
 * reports the day before for anyone east of Greenwich — and this string is
 * compared against s.ends_on::text, so being a day out means the "already told
 * them" check never matches. It re-sent every pass, and then silenced the
 * following cycle by colliding with it. The same trap as the expiry warnings.
 */
const ymd = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const money = (paise) => `₹${(Number(paise || 0) / 100).toFixed(Number(paise || 0) % 100 ? 2 : 0)}`;

/** Subscriptions ending soon that nobody has been told about yet. */
async function due(limit = 20) {
  const notice = await settings.num('renewal_notice_days', 3);
  const { rows } = await db.query(
    `SELECT s.id AS subscription_id, s.user_id, s.vehicle_id, s.ends_on,
            v.reg_no, v.maker, v.model,
            u.mobile, u.display_name, u.wa_profile_name, u.email,
            u.email_verified_at, u.email_unsubscribed_at, u.email_token, u.is_paused
       FROM subscriptions s
       JOIN vehicles v ON v.id = s.vehicle_id
       JOIN users    u ON u.id = s.user_id
      WHERE s.is_active
        AND s.vehicle_id IS NOT NULL
        AND u.deactivated_at IS NULL AND NOT u.is_paused
        AND s.ends_on BETWEEN CURRENT_DATE AND (CURRENT_DATE + $1::int)
        /*
         * Said once per SUBSCRIPTION AND END DATE, not once per subscription.
         * A renewal extends the same row rather than creating a new one, so
         * keying on the id alone would warn a repeat customer exactly once and
         * never again — the quietest possible way to lose them.
         */
        AND NOT EXISTS (SELECT 1 FROM event_log e
                         WHERE e.kind = 'renewal_notice'
                           AND e.detail->>'subscription_id' = s.id::text
                           AND e.detail->>'ends_on' = s.ends_on::text)
        /*
         * …and not if a LIVE subscription already runs past this one. Old
         * inactive rows are history and must not silence the warning: they
         * commonly carry later dates than the row being checked.
         */
        AND NOT EXISTS (SELECT 1 FROM subscriptions s2
                         WHERE s2.user_id = s.user_id AND s2.vehicle_id = s.vehicle_id
                           AND s2.is_active AND s2.id <> s.id
                           AND s2.ends_on > s.ends_on)
      ORDER BY s.ends_on
      LIMIT $2`, [notice, limit]);
  return rows;
}

function mailFor(person, { regNo, endsOn, paise, days }) {
  const name = String(person.display_name || person.wa_profile_name || '').split(' ')[0] || 'there';
  const site = C.SITE();
  const out = T.layout({
    tagline: 'Monitoring ending soon',
    preheader: `Monitoring for ${regNo} ends on ${istDay(endsOn)}.`,
    badge: { text: 'Ending soon', tone: 'watch' },
    title: `Monitoring for ${regNo} ends on ${istDay(endsOn)}`,
    lead: `Hi ${name}, after that date GaadiPe stops checking ${regNo} for new challans, `
      + 'and stops warning you before insurance, PUC, road tax or fitness runs out.',
    stats: [['Vehicle', regNo], ['Ends', istDay(endsOn)], ['Renew for', money(paise)]],
    blocks: [`<div style="font-size:13px;line-height:1.7;color:#0b1f1c;background:#f6faf9;
      border:1px solid #e3ecea;border-radius:10px;padding:14px 16px;">
      <b>Another ${T.esc(String(days))} days for ${T.esc(money(paise))}</b> — less than half what the first report cost,
      because the report is already yours. You keep getting told the moment a new challan appears,
      and before any document runs out.</div>`,
      `<div style="font-size:13px;line-height:1.6;color:#41514e;">
        Nothing renews automatically and nothing has been charged. If you would rather stop, do nothing —
        monitoring simply ends on ${T.esc(istDay(endsOn))}.</div>`],
    cta: { label: `Renew for ${money(paise)}`, url: `${site}/app/vehicle/${encodeURIComponent(regNo)}` },
    footer: 'You are receiving this because you bought GaadiPe monitoring for this vehicle.',
    footerHtml: person.email_token
      ? `<a href="${T.esc(`${C.API()}/email/unsubscribe/${person.email_token}`)}" style="color:#0f766e;">Unsubscribe</a>`
      : '',
  });
  return { subject: `Monitoring for ${regNo} ends on ${istDay(endsOn)} — GaadiPe`, ...out };
}

async function runOnce({ limit = 20 } = {}) {
  if (String(await settings.get('renewal_enabled', 'true')).toLowerCase() === 'false') return { off: true };
  const rows = await due(limit);
  let told = 0;

  for (const r of rows) {
    const priced = await billing.reportPriceFor(r.user_id, r.vehicle_id);
    if (!priced) continue;

    /*
     * RECORDED BEFORE SENDING. If the send fails the customer hears nothing,
     * which is a pity; if the record fails after a successful send they hear
     * it every hour for three days, which is a reason to block the number.
     */
    await db.query(
      `INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'renewal_notice', $3)`,
      [r.user_id, r.vehicle_id, JSON.stringify({
        subscription_id: String(r.subscription_id),
        // The DATE as Postgres renders it, because the check above compares
        // against s.ends_on::text and the two must agree exactly.
        ends_on: ymd(r.ends_on),
        price_paise: priced.paise,
      })]);

    const payload = { regNo: r.reg_no, endsOn: r.ends_on, paise: priced.paise,
                      days: priced.plan.duration_days || 28 };

    if (r.email && r.email_verified_at && !r.email_unsubscribed_at) {
      const out = await C.deliver(r.email, mailFor(r, payload), r.email_token);
      if (out.ok) told += 1;
      else if (!out.skipped) console.warn('[renewal] email failed for %s: %s', r.reg_no, out.error);
    }

    // WhatsApp, once there is a number: the approved template. Every parameter
    // is non-empty and single-line, which is what Meta requires.
    if (config.whatsapp.enabled) {
      const send = require('../whatsapp/send');
      const name = String(r.display_name || r.wa_profile_name || '').split(' ')[0] || 'there';
      const out = await send.template(
        r.mobile,
        await settings.get('wa_template_renewal', 'gp_renewal_en_v1'),
        // {{4}} is the window and {{5}} the price: Meta numbers variables in the
        // order they appear, and the days figure comes first in the sentence.
        [name, r.reg_no, istDay(r.ends_on), String(priced.plan.duration_days || 28), money(priced.paise)],
        { language: await settings.get('wa_template_language', 'en') },
      ).catch(() => ({ ok: false }));
      if (out.ok) told += 1;
    }
  }

  if (told) console.log('[renewal] told %d customer(s) monitoring is ending', told);
  return { told, due: rows.length };
}

function start(everySeconds = 6 * 3600) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runOnce(); } catch (e) { console.error('[renewal] pass failed:', e.message); }
    finally { running = false; }
  };
  setInterval(tick, everySeconds * 1000).unref();
  setTimeout(tick, 30000).unref();
  console.log(`  renewal notice job: every ${everySeconds}s`);
}

module.exports = { start, runOnce, due, mailFor };
