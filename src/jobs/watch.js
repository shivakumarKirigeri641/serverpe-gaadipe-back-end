/**
 * src/jobs/watch.js
 * ---------------------------------------------------------------------------
 * The part that makes GaadiPe a service rather than a lookup.
 *
 * Every pass does three things, in this order:
 *
 *   1. re-check the vehicles that are due, and compare against what we last saw
 *   2. queue what changed, and each evening send one message per mobile
 *      covering all its vehicles (eveningDigest)
 *   3. move trials and subscriptions through their lifecycle
 *
 * WHY THE DIFF MATTERS MORE THAN THE FETCH: a customer does not want to know
 * their insurance expires in 47 days, every day, for 47 days. They want to hear
 * from us when something *becomes* true — a challan appeared, a document
 * crossed into the warning window. So findings are compared with the previous
 * snapshot and with what we have already said, and silence is the correct
 * output on almost every pass.
 *
 * Nothing here starts a conversation with a stranger. Every message goes to
 * someone who asked to be watched, which is what makes it legitimate to send
 * outside the 24-hour window at all.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const gateway = require('../vehicle/gateway');
const store = require('../vehicle/store');
const send = require('../whatsapp/send');
const report = require('../whatsapp/report');
const settings = require('../util/settings');
const blocks = require('../admin/blocks');

const MS_MIN = 60 * 1000;

// Written out rather than toLocaleDateString, which returns "Sep" in one place
// and "Sept" in another for the same product.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) =>
  `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/* Which document warnings are worth sending, and when. A 60-day horizon on
   insurance gives time to shop for a policy; PUC can be done the same day. */
const WARN_DAYS = {
  Insurance: 30,
  PUC: 15,
  Registration: 60,
  'Road tax': 30,
  Fitness: 30,
  Permit: 30,
};

/** Everything due for a re-check, oldest first so nobody starves. */
async function due(limit = 50) {
  const { rows } = await db.query(
    `SELECT w.id, w.user_id, w.vehicle_id, w.expires_at, w.fail_count,
            w.challan_interval_hours, w.created_at,
            extract(epoch FROM (now() - w.created_at)) / 86400 AS age_days,
            v.reg_no, u.mobile, u.wa_profile_name, u.is_paused, u.preferred_language
       FROM watches w
       JOIN vehicles v ON v.id = w.vehicle_id
       JOIN users    u ON u.id = w.user_id
      WHERE w.is_active
        AND (w.expires_at IS NULL OR w.expires_at > now())
        AND w.challan_next_check_at <= now()
        AND NOT u.is_paused
      ORDER BY w.challan_next_check_at
      LIMIT $1`, [limit]);
  return rows;
}

/** What we last saw for this vehicle, to compare against. */
async function previous(vehicleId) {
  const { rows } = await db.query(
    `SELECT dataset, data FROM vehicle_snapshots WHERE vehicle_id = $1`, [vehicleId]);
  return Object.fromEntries(rows.map(r => [r.dataset, r.data]));
}

/**
 * What is worth telling this person today.
 *
 * Returns { key, text } pairs. `text` is the phrase shown — the caller joins
 * them with " · " because a template variable may not contain a newline.
 * `key` is what makes it the SAME finding tomorrow: the phrase cannot be,
 * because "expires in 29 days" becomes "expires in 28 days" overnight.
 */
function findings(data, before) {
  const out = [];

  // New challans: compare counts, and say how many are new rather than how
  // many exist. "2 new challans" is news; "5 pending challans" is a fact they
  // already know.
  const now = data.challans?.pending_count ?? null;
  const was = before.challan?.pending_count ?? null;
  if (now !== null && was !== null && now > was) {
    const n = now - was;
    out.push({ key: `challans:${now}`, label: 'New challan', text: `${n} new challan${n === 1 ? '' : 's'}` });
  } else if (now !== null && was === null && now > 0) {
    out.push({ key: `challans:${now}`, label: 'Pending challans', text: `${now} pending challan${now === 1 ? '' : 's'}` });
  }

  // Documents that have crossed into their warning window, or lapsed. One key
  // per document, per expiry date, per stage: a renewed document has a new
  // date and may be warned about again; "expiring" and "expired" are two
  // different pieces of news.
  for (const d of report.documentsOf(data.rc || {})) {
    const horizon = WARN_DAYS[d.label];
    if (horizon === undefined) continue;
    const date = new Date(d.date).toISOString().slice(0, 10);
    if (d.days < 0) {
      out.push({ key: `${d.label}:${date}:expired`, label: d.label, text: `${d.name} expired ${report.human(d.days)}` });
    } else if (d.days <= horizon) {
      out.push({ key: `${d.label}:${date}:expiring`, label: d.label, text: `${d.name} expires ${report.human(d.days)}` });
    }
  }

  return out;
}

/**
 * Say it once per watch. A document that expires in 30 days would otherwise
 * produce a message every day for a month, which is how a useful service
 * becomes the thing someone mutes.
 */
async function alreadySaid(watchId, key) {
  const row = await db.one(
    `SELECT 1 FROM event_log
      WHERE kind = 'watch_alert'
        AND detail->>'watch_id' = $1
        AND detail->'keys' ? $2
      UNION ALL
     SELECT 1 FROM pending_alerts WHERE watch_id = $1::bigint AND key = $2
      LIMIT 1`, [String(watchId), key]);
  return Boolean(row);
}

async function checkOne(w) {
  // Blocked while the watch was running: stop here rather than spending a
  // lookup and then discovering the message cannot be sent.
  const blocked = await blocks.anyBlocked({ mobile: w.mobile, regNo: w.reg_no });
  if (blocked) {
    console.log('[watch] skipping %s — %s is blocked', w.reg_no, blocked);
    await db.query(
      `UPDATE watches SET challan_next_check_at = now() + interval '6 hours', modified_at = now()
        WHERE id = $1`, [w.id]);
    return { sent: false, blocked };
  }

  let data;
  try {
    // ULIP only, never the paid RC backup (user, 2026-10-02): while VAHAN is
    // down the saved RC stands in and challans and FASTag are still checked.
    data = await gateway.full(w.reg_no, { backup: 0, rc_saved: 1 });
  } catch (e) {
    data = null;
  }

  if (!data || data.success !== true) {
    // Back off rather than hammering a vehicle the upstream keeps refusing.
    await db.query(
      `UPDATE watches
          SET fail_count = fail_count + 1,
              challan_next_check_at = now() + (least(fail_count + 1, 8) || ' hours')::interval,
              modified_at = now()
        WHERE id = $1`, [w.id]);
    console.warn('[watch] %s check failed (%d)', w.reg_no, w.fail_count + 1);
    return { sent: false };
  }

  const before = await previous(w.vehicle_id);
  const items = findings(data, before);

  // Store AFTER diffing — the comparison needs the old snapshot.
  // GaadiPe's own re-check: saved and costed to the customer, but not counted as their check.
  await store.record(w.user_id, data, { link: false }).catch(e => console.error('[watch] store:', e.message));

  // Each dataset is rescheduled on its own clock. Challans are the only thing
  // that genuinely changes week to week; an RC's expiry dates do not move
  // between checks, and a FASTag's status almost never does. Checking all three
  // daily costs 112 upstream calls a cycle against 20 for these intervals — the
  // difference between surviving a ULIP price list and not.
  const fallback = await settings.num('watch_check_interval_minutes', 48 * 60);

  /*
   * THE CADENCE SLOWS WITH AGE (user, 2026-09-23). A watch now runs 90 days
   * rather than 28, and checking all of it at the opening pace would nearly
   * triple what a ₹19 sale costs upstream. Someone who has just paid wants to
   * know about a new challan within a day or two; by the third month a week is
   * plenty. Worry fades. The ULIP bill does not.
   */
  const taperAfter = await settings.num('watch_taper_after_days', 28);
  const late = Number(w.age_days || 0) > taperAfter;
  const every = {
    challan: late
      ? await settings.num('watch_interval_minutes_challan_late', 7 * 24 * 60)
      : await settings.num('watch_interval_minutes_challan', fallback),
    rc: late
      ? await settings.num('watch_interval_minutes_rc_late', 30 * 24 * 60)
      : await settings.num('watch_interval_minutes_rc', fallback),
    fastag:  await settings.num('watch_interval_minutes_fastag', fallback),
  };
  await db.query(
    `UPDATE watches
        SET last_checked_at = now(), fail_count = 0,
            challan_next_check_at = now() + ($2 || ' minutes')::interval,
            rc_next_check_at      = now() + ($3 || ' minutes')::interval,
            fastag_next_check_at  = now() + ($4 || ' minutes')::interval,
            modified_at = now()
      WHERE id = $1`,
    [w.id, String(every.challan), String(every.rc), String(every.fastag)]);

  const fresh = [];
  for (const item of items) {
    if (!await alreadySaid(w.id, item.key)) fresh.push(item);
  }
  if (!fresh.length) return { sent: false, items };

  /* QUEUED, NOT SENT (user, 2026-09-18). The evening digest sends it, together
     with anything else found for this person's vehicles today. */
  for (const i of fresh) {
    await db.query(
      `INSERT INTO pending_alerts (user_id, watch_id, vehicle_id, reg_no, key, label, text)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (watch_id, key) DO NOTHING`,
      [w.user_id, w.id, w.vehicle_id, w.reg_no, i.key, i.label, i.text]);
  }
  return { sent: false, queued: true, items: fresh };
}

/* The time in India, whatever the server's clock is set to. */
const istNow = () => new Date(Date.now() + 5.5 * 3600 * 1000);

/**
 * THE EVENING DIGEST (user, 2026-09-18): once a day, from 7 pm IST, one message
 * per mobile covering every vehicle with something new — a new challan, a
 * document newly expiring or newly expired. Nobody gets two in a day; nobody
 * hears about the same thing twice; nothing goes out after 10 pm.
 */
async function eveningDigest() {
  const from = await settings.num('alert_send_hour_ist', 19);
  const until = await settings.num('alert_send_until_hour_ist', 22);
  const hour = istNow().getUTCHours();
  if (hour < from || hour >= until) return { sent: 0, reason: 'outside the evening window' };

  const today = istNow().toISOString().slice(0, 10);
  const { rows: people } = await db.query(
    `SELECT DISTINCT p.user_id, u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name,
            u.preferred_language, u.is_paused,
            u.email, u.email_verified_at, u.email_unsubscribed_at, u.email_token
       FROM pending_alerts p JOIN users u ON u.id = p.user_id
      WHERE p.sent_at IS NULL AND NOT u.is_paused
        AND NOT EXISTS (SELECT 1 FROM event_log e
                         WHERE e.user_id = p.user_id AND e.kind = 'watch_digest'
                           AND e.detail->>'ist_date' = $1)`, [today]);

  let sent = 0;
  for (const person of people) {
    if (await blocks.isBlocked('mobile', person.mobile)) continue;
    const { rows: items } = await db.query(
      `SELECT p.id, p.watch_id, p.vehicle_id, p.reg_no, p.key, p.label, p.text
         FROM pending_alerts p JOIN watches w ON w.id = p.watch_id
        WHERE p.user_id = $1 AND p.sent_at IS NULL AND w.is_active
        ORDER BY p.reg_no, p.id`, [person.user_id]);
    // Blocked vehicles are left out, and their findings set aside for good.
    const ok = [];
    for (const i of items) {
      if (await blocks.isBlocked('vehicle', i.reg_no)) {
        await db.query(`UPDATE pending_alerts SET sent_at = now() WHERE id = $1`, [i.id]);
      } else ok.push(i);
    }
    if (!ok.length) continue;

    const byVehicle = new Map();
    for (const i of ok) {
      if (!byVehicle.has(i.reg_no)) byVehicle.set(i.reg_no, []);
      byVehicle.get(i.reg_no).push(i);
    }
    const regs = [...byVehicle.keys()];
    const summary = regs.map((r) => `${r}: ${byVehicle.get(r).map((i) => i.text).join(', ')}`)
      .join(' · ').slice(0, 900);
    const w = {
      mobile: person.mobile, wa_profile_name: person.name, preferred_language: person.preferred_language,
      reg_no: regs.length === 1 ? regs[0] : `${regs[0]} +${regs.length - 1} more`,
    };
    /*
     * EMAIL FIRST (user, 2026-10-07). With the WhatsApp number disabled by Meta,
     * a confirmed email is how the evening alert reaches anyone; WhatsApp is
     * tried as well only while it is switched on. Either one delivered counts.
     */
    let r = { ok: false, error: 'no confirmed email, and WhatsApp is off' };
    const errors = [];
    if (person.email && person.email_verified_at && !person.email_unsubscribed_at) {
      const C = require('../mail/customer');
      const out = await C.deliver(person.email, alertMail(person, byVehicle), person.email_token);
      if (out.ok) r = { ok: true, channel: 'email' };
      else errors.push(out.skipped ? 'email held (test mode)' : `email: ${out.error}`);
    }
    // A browser notification on every phone where they allowed it; tapping opens the chat.
    const pushed = await require('../site/push').toCustomer(person.user_id, {
      title: regs.length === 1 ? `🔔 ${regs[0]}: ${byVehicle.get(regs[0]).map((i) => i.label).join(', ')}` : `🔔 Updates on ${regs.length} vehicles`,
      body: summary.slice(0, 300), url: regs.length === 1 ? `/chat?reg=${encodeURIComponent(regs[0])}` : '/chat', tag: `watch-${today}`,
    }).catch((e) => { errors.push(`push: ${e.message}`); return 0; });
    if (pushed) r = { ok: true, channel: r.ok ? `${r.channel}+push` : 'push' };
    if (require('../config').config.whatsapp.enabled) {
      const wa = await notify(w, ok, summary, byVehicle);
      if (wa?.ok) r = { ok: true, channel: r.ok ? 'email+whatsapp' : 'whatsapp' };
      else errors.push(`whatsapp: ${wa?.error}`);
    }
    if (!r.ok && errors.length) r.error = errors.join('; ');
    if (!r?.ok) {
      // Nothing delivered: the findings stay queued for tomorrow evening, and
      // today is marked so this does not retry every minute.
      await db.query(
        `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'watch_digest', $2)`,
        [person.user_id, JSON.stringify({ ist_date: today, vehicles: regs, failed: true, error: String(r?.error || '').slice(0, 300) })]);
      continue;
    }

    await db.query(`UPDATE pending_alerts SET sent_at = now() WHERE id = ANY($1::bigint[])`, [ok.map((i) => i.id)]);
    for (const [reg, list] of byVehicle) {
      await db.query(
        `INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'watch_alert', $3)`,
        [person.user_id, list[0].vehicle_id,
         JSON.stringify({ watch_id: String(list[0].watch_id), reg_no: reg,
                          items: list.map((i) => i.text), keys: list.map((i) => i.key), digest: true })]);
    }
    await db.query(
      `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'watch_digest', $2)`,
      [person.user_id, JSON.stringify({ ist_date: today, vehicles: regs, items: ok.length })]);
    sent += 1;
  }
  if (sent) console.log('[watch] evening digest sent to %d customer(s)', sent);
  return { sent };
}

/**
 * The evening alert as an email: each vehicle with what was found, and a button
 * into the GaadiPe chat, where the vehicle opens with its full record.
 */
function alertMail(person, byVehicle) {
  const C = require('../mail/customer');
  const T = require('../mail/templates');
  const name = String(person.name || '').split(' ')[0] || 'there';
  const regs = [...byVehicle.keys()];
  const count = [...byVehicle.values()].reduce((n, l) => n + l.length, 0);
  // One card per vehicle (2026-10-07): the plate, then each finding with its pill.
  const toneOf = (key) => (/:expired$/.test(key || '') ? 'bad' : /:expiring$/.test(key || '') ? 'warn' : 'info');
  const cards = regs.map((reg) => T.vehicleCard({
    reg, items: byVehicle.get(reg).map((i) => ({ label: i.label, text: i.text, tone: toneOf(i.key) })),
  }));
  const bad = [...byVehicle.values()].flat().some((i) => toneOf(i.key) === 'bad');
  const out = T.layout({
    tagline: 'Your vehicles today',
    preheader: regs.map((r) => `${r}: ${byVehicle.get(r).map((i) => i.text).join(', ')}`).join(' · ').slice(0, 140),
    badge: { text: count === 1 ? 'Something changed' : `${count} things changed`, tone: bad ? 'wrong' : 'watch' },
    title: regs.length === 1 ? `An update on ${regs[0]}` : `Updates on ${regs.length} of your vehicles`,
    lead: `Hi ${name}, GaadiPe checked your vehicle${regs.length === 1 ? '' : 's'} against the Government records (VAHAN) today. Here is what changed.`,
    intro: cards.map((c) => c.html),
    textBlocks: cards.map((c) => c.text),
    blocks: [`<div style="font-size:12.5px;line-height:1.6;color:#41514e;">Already renewed? The RTO record can take a few days to show the new date — GaadiPe keeps checking and will tell you when it does.</div>`],
    cta: { label: regs.length === 1 ? `Open ${regs[0]} in GaadiPe` : 'Open GaadiPe', url: `${C.SITE()}/chat${regs.length === 1 ? `?reg=${encodeURIComponent(regs[0])}` : ''}` },
    footer: 'You are receiving this because you asked GaadiPe to watch this vehicle.',
    footerHtml: person.email_token
      ? `<a href="${T.esc(`${C.API()}/email/unsubscribe/${person.email_token}`)}" style="color:#0f766e;">Unsubscribe</a>` : '',
  });
  return { subject: regs.length === 1 ? `🔔 ${regs[0]}: ${byVehicle.get(regs[0]).map((i) => i.label).join(', ')} — GaadiPe` : `🔔 Updates on ${regs.length} vehicles — GaadiPe`, ...out };
}

/**
 * Send the alert. Inside the 24-hour window a plain message is free and reads
 * better; outside it, only an approved template will deliver.
 */
/**
 * ONE MESSAGE PER VEHICLE PER PASS, whatever was found. Every template message
 * outside the window is billed by Meta, and three messages about one vehicle
 * on one morning read as spam — so the findings share a single message:
 * parameter 3 names what needs attention, parameter 4 says what about it.
 */
async function notify(w, items, summary, byVehicle = null) {
  const name = (w.wa_profile_name || 'there').split(' ')[0];
  const what = [...new Set(items.map(i => i.label))].join(', ');

  // STOP means nothing we start (user, 2026-09-30). send.js refuses templates;
  // a plain message inside the 24-hour window is not refused there, because
  // replies must still go — so it is checked here.
  if (await send.optedOut(w.mobile)) return { ok: false, error: 'opted_out' };

  if (await send.windowOpen(w.mobile)) {
    // Inside the 24-hour window a plain message is free, and can list vehicles line by line.
    const body = byVehicle
      ? [...byVehicle].map(([reg, list]) => `🚗 *${reg}*\n${list.map((i) => `• ${i.text}`).join('\n')}`).join('\n\n')
      : `🔔 *${w.reg_no}*\n\n${summary}`;
    await send.text(w.mobile, `🔔 *Today's update from GaadiPe*\n\n${body}\n\n`
      + 'Open gaadipe.in to see the full record.');
    return { ok: true, template: null };
  }

  /*
   * ONE APPROVED TEMPLATE (user, 2026-09-29). The per-language and v2 alert
   * templates are not on the account (#132001) and are gone from here; alerts
   * go out as gp_monitoring_alert_en_v1 — 1 name, 2 vehicle, 3 what was found,
   * 4 what to do.
   */
  const checkedOn = fmtDate(new Date());
  const tpl = await settings.get('template_daily_status', 'gp_monitoring_alert_en_v1');
  const r = await send.template(w.mobile, tpl,
    [name, w.reg_no, `${summary} (checked ${checkedOn})`.slice(0, 900),
     `Please take a look at the ${what.toLowerCase() || 'change'} — the details are in your GaadiPe report. We will keep watching and tell you when anything changes.`],
    { language: await settings.get('wa_template_language', 'en') });
  if (r.ok) return { ok: true, template: tpl };
  console.warn('[watch] alert template %s failed: %s', tpl, r.error);
  return { ok: false, error: r.error };
}

/**
 * Trials and subscriptions ending. Two passes: a notice before the end, then
 * the end itself.
 */
async function lifecycle() {
  const noticeBefore = await settings.num('trial_notice_before_minutes', 24 * 60);

  const ending = await db.query(
    `SELECT w.id, w.expires_at, v.reg_no, u.mobile, u.wa_profile_name
       FROM watches w
       JOIN vehicles v ON v.id = w.vehicle_id
       JOIN users    u ON u.id = w.user_id
      WHERE w.is_active AND w.subscription_id IS NULL
        AND w.expires_at IS NOT NULL
        AND w.expires_at <= now() + ($1 || ' minutes')::interval
        AND w.expires_at > now()
        AND NOT u.is_paused
        AND NOT EXISTS (
          SELECT 1 FROM event_log e
           WHERE e.kind = 'trial_ending_notice'
             AND e.detail->>'watch_id' = w.id::text)`,
    [String(noticeBefore)]);

  for (const t of ending.rows) {
    const price = Math.round(await settings.num('first_payment_paise', 4900) / 100);
    const when = new Date(t.expires_at);
    if (!(await send.optedOut(t.mobile)) && await send.windowOpen(t.mobile)) {
      await send.text(t.mobile,
        `Your free trial for *${t.reg_no}* ends on *${fmtDate(when)}*.\n\n`
        + `To keep monitoring this vehicle, it is ₹${price} for 28 days. `
        + 'Nothing is charged automatically.');
    }
    // Outside the window nothing is sent: there is no approved trial template
    // (and trials are off — trial_enabled).
    await db.query(
      `INSERT INTO event_log (user_id, kind, detail)
       SELECT user_id, 'trial_ending_notice', $2 FROM watches WHERE id = $1`,
      [t.id, JSON.stringify({ watch_id: String(t.id), reg_no: t.reg_no })]);
  }

  /* The renewal reminder before a paid period ends is sent by jobs/renewal.js
     (WhatsApp gp_renewal_en_v1 + email). A second copy here used
     gp_premiumrenewal_v1, which is not on the account, and its "already told"
     marker then stopped the working one (user, 2026-09-29). */

  // Subscriptions that have run out stop being active, which stops their watch.
  const lapsed = await db.query(
    `UPDATE subscriptions SET is_active = false, modified_at = now()
      WHERE is_active AND ends_on < CURRENT_DATE
      RETURNING id, user_id`);
  for (const l of lapsed.rows) {
    await db.query(
      `UPDATE watches SET is_active = false, modified_at = now()
        WHERE subscription_id = $1`, [l.id]);
    await db.query(
      `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'subscription_lapsed', $2)`,
      [l.user_id, JSON.stringify({ subscription_id: String(l.id) })]);
  }
  if (lapsed.rowCount) console.log('[watch] %d subscription(s) lapsed', lapsed.rowCount);

  // Expire what has run out. Nothing is said here: the notice above already
  // said it, and a second message at the moment of expiry reads as nagging.
  const expired = await db.query(
    `UPDATE watches SET is_active = false, modified_at = now()
      WHERE is_active AND expires_at IS NOT NULL AND expires_at <= now()
      RETURNING id, user_id, vehicle_id`);
  for (const e of expired.rows) {
    await db.query(
      `INSERT INTO event_log (user_id, vehicle_id, kind, detail)
            VALUES ($1, $2, 'watch_expired', $3)`,
      [e.user_id, e.vehicle_id, JSON.stringify({ watch_id: String(e.id) })]);
  }
  if (expired.rowCount) console.log('[watch] %d watch(es) expired', expired.rowCount);

  return { notified: ending.rowCount, renewals: 0,
           lapsed: lapsed.rowCount, expired: expired.rowCount };
}

/*
 * THE DAILY "ALL CLEAR" (user, 2026-09-27). While GaadiPe is new, silence
 * reads as "is this working?" — so every paying customer with monitoring on
 * hears once each evening, even when nothing changed: no new challans, and
 * each document's date. Switched off with watch_daily_status_enabled when the
 * business is ready for "only when something happens".
 *
 * No extra lookup is spent: it reads what the last check stored. Skipped for
 * anyone who already got a real alert today (they have heard), anyone paused,
 * blocked or who replied STOP (send.js refuses those). Once per person per
 * IST day, recorded as watch_status in event_log.
 *
 * ALTERNATE DAYS (user, 2026-10-09, after Meta's "spam rate limit"): at most
 * once every watch_daily_status_every_days (2) days. A real alert (watch_digest)
 * counts too, so nobody hears an alert one evening and an "all clear" the next.
 */
// { mobile } sends to that one customer only, at any hour — for testing from
// the server: node -e "require('./src/jobs/watch').dailyStatus({ mobile: '98xxxxxxxx' })"
/*
 * THE LAUNCH UPDATE (user, 2026-10-09, WhatsApp back after the ban): once, by
 * hand, every paying customer with monitoring on gets today's status of their
 * vehicles — a real update, so it may go as the utility template — whatever
 * day of monitoring they are on. Never to anyone who chose "Alert only on
 * change", said STOP, or heard from us in the last day or two (the same rules
 * as above). Run first with dryRun: true to see who would get it:
 *   node -e "require('./src/jobs/watch').dailyStatus({ everyone: true, dryRun: true }).then(r=>{console.log(r);process.exit(0)})"
 */
async function dailyStatus({ mobile = null, everyone = false, dryRun = false, gapMs = 0, onEach = null } = {}) {
  const byHand = Boolean(mobile || everyone);
  if (!byHand && !await settings.bool('watch_daily_status_enabled', false)) return { sent: 0 };
  const from = await settings.num('alert_send_hour_ist', 19);
  const until = await settings.num('alert_send_until_hour_ist', 22);
  const hour = istNow().getUTCHours();
  if (!byHand && (hour < from || hour >= until)) return { sent: 0 };

  const today = istNow().toISOString().slice(0, 10);
  // The first IST date that still counts as "recent": every 2 days → yesterday.
  const every = Math.max(1, await settings.num('watch_daily_status_every_days', 2));
  const since = new Date(istNow().getTime() - (every - 1) * 86400000).toISOString().slice(0, 10);
  const { rows } = await db.query(
    `SELECT w.id, w.user_id, w.vehicle_id, w.last_checked_at, w.created_at, v.reg_no,
            u.mobile, coalesce(u.display_name, u.wa_profile_name) AS name
       FROM watches w
       JOIN vehicles v ON v.id = w.vehicle_id
       JOIN users u    ON u.id = w.user_id
      WHERE w.is_active AND (w.expires_at IS NULL OR w.expires_at > now()) AND NOT u.is_paused
        -- Paid for THIS vehicle (user, 2026-09-27): dates and challans are
        -- what the ₹19 buys, so a free watch on another vehicle of a paying
        -- customer must never get them.
        AND EXISTS (SELECT 1 FROM payments p WHERE p.user_id = w.user_id AND p.status = 'paid' AND p.amount_paise > 0
                      AND p.raw->>'vehicle_id' = w.vehicle_id::text)
        AND NOT EXISTS (SELECT 1 FROM event_log e WHERE e.user_id = w.user_id
                          AND e.kind IN ('watch_status', 'watch_digest') AND e.detail->>'ist_date' BETWEEN $4 AND $1
                          AND coalesce(e.detail->>'failed', 'false') <> 'true')
        AND ($2::text IS NULL OR u.mobile = $2)
        -- "Only alert changes" / "Keep me updated" (2026-10-09): the latest tap counts.
        AND (SELECT so.kind FROM event_log so WHERE so.user_id = w.user_id
               AND so.kind IN ('watch_status_off', 'watch_status_on')
             ORDER BY so.created_at DESC, so.id DESC LIMIT 1) IS DISTINCT FROM 'watch_status_off'
        -- Strictly the first N days after the customer FIRST tapped "Agree &
        -- continue" (user, 2026-09-27) — not from when a vehicle was enrolled,
        -- so a second vehicle does not restart it. A website buyer who never
        -- saw the WhatsApp terms counts from when their account was made.
        -- 0 = every day, as long as monitoring runs.
        AND ($3::int <= 0 OR coalesce(
              (SELECT min(c.created_at) FROM event_log c
                WHERE c.kind = 'consent_accepted' AND c.detail->>'mobile' = u.mobile),
              u.created_at) > now() - make_interval(days => $3::int))
      ORDER BY w.user_id, v.reg_no`, [today, mobile ? String(mobile).replace(/\D/g, '').slice(-10) : null,
                                      everyone ? 0 : await settings.num('watch_daily_status_days', 7), since]);

  const people = new Map();
  for (const r of rows) {
    if (!people.has(r.user_id)) people.set(r.user_id, []);
    people.get(r.user_id).push(r);
  }
  if (dryRun) {
    const would = [];
    for (const [, list] of people) {
      const m = list[0].mobile;
      const why = await send.optedOut(m) ? 'STOP' : (await send.consentGate(m, await settings.get('template_daily_status', 'gp_monitoring_alert_en_v1'))).error || null;
      would.push({ mobile: `••${String(m).slice(-4)}`, name: list[0].name || null, vehicles: list.map((w) => w.reg_no),
                   goes_as: why ? `NOT SENT (${why})` : (await send.windowOpen(m) ? 'free message' : 'template') });
    }
    return { dryRun: true, people: would.length, would };
  }

  let sent = 0;
  let n = 0;
  for (const [userId, list] of people) {
    // A pause between customers when sent by hand (the launch update: 5 s).
    if (gapMs > 0 && n > 0) await new Promise((r) => setTimeout(r, gapMs));
    n += 1;
    // Claimed first, so two passes in the same minute cannot both send.
    const claim = await db.one(
      `INSERT INTO event_log (user_id, kind, detail)
       SELECT $1, 'watch_status', $2
        WHERE NOT EXISTS (SELECT 1 FROM event_log WHERE user_id = $1 AND kind = 'watch_status' AND detail->>'ist_date' = $3
                            AND coalesce(detail->>'failed', 'false') <> 'true')
       RETURNING id`, [userId, JSON.stringify({ ist_date: today, vehicles: list.map((w) => w.reg_no) }), today]);
    if (!claim) continue;

    const lines = [];
    for (const w of list) lines.push({ reg: w.reg_no, ...statusOf(await previous(w.vehicle_id)) });
    const first = list[0];
    const checked = list.map((w) => new Date(w.last_checked_at || w.created_at)).sort((a, b) => b - a)[0];
    const name = String(first.name || 'there').split(' ')[0];

    let out;
    if (await send.optedOut(first.mobile)) {
      out = { ok: false, error: 'opted_out' }; // STOP (user, 2026-09-30) — see notify()
    } else if (await send.windowOpen(first.mobile)) {
      out = await send.text(first.mobile, '✅ *Today\'s update from GaadiPe*\n\n'
        + lines.map((l) => `🚗 *${l.reg}*\n${l.text.split(' · ').map((t) => `• ${t}`).join('\n')}`).join('\n\n')
        + `\n\n_Last checked ${fmtDate(checked)}. We will message you if anything changes._`);
    } else {
      const summary = (lines.map((l) => (lines.length > 1 ? `${l.reg}: ${l.text}` : l.text)).join(' · ')
        + ` (last checked ${fmtDate(checked)})`).slice(0, 900);
      // The approved gp_monitoring_alert_en_v1: 1 name, 2 vehicle, 3 status, 4 action.
      const expired = [...new Set(lines.flatMap((l) => l.expired))];
      const challans = lines.some((l) => l.challans);
      const todo = [expired.length ? `renew your ${expired.join(', ')}` : null, challans ? 'clear the pending challans' : null].filter(Boolean);
      const action = todo.length
        ? `Please ${todo.join(' and ')}. We will keep watching and tell you when anything changes.`
        : 'Nothing to do. We will keep watching and tell you if anything changes.';
      out = await send.template(first.mobile,
        await settings.get('template_daily_status', 'gp_monitoring_alert_en_v1'),
        [name, lines.length === 1 ? first.reg_no : `${first.reg_no} +${lines.length - 1} more`, summary, action],
        { language: await settings.get('wa_template_language', 'en') });
    }
    if (out?.ok) sent += 1;
    else {
      await db.query(`UPDATE event_log SET detail = detail || $2::jsonb WHERE id = $1`,
        [claim.id, JSON.stringify({ failed: true, error: String(out?.error || '').slice(0, 300) })]);
      console.warn('[watch] daily status to user %s failed: %s', userId, out?.error);
    }
    // Sent by hand: report each one; returning false stops the run (scripts/launch-update.js).
    if (onEach && (await onEach({ n, of: people.size, mobile: first.mobile, vehicles: list.map((w) => w.reg_no), out })) === false) break;
  }
  if (sent) console.log('[watch] daily all-clear sent to %d customer(s)', sent);
  return { sent };
}

/** "No pending challans · Insurance valid till 12 Mar 2027 · PUC expired 2 months ago" — one line, no newlines. */
const statusLine = (snap) => statusOf(snap).text;
function statusOf(snap) {
  const expired = [];
  let challans = false;
  const bits = [];
  const pending = snap.challan?.pending_count;
  if (pending === 0) bits.push('No pending challans ✅');
  else if (pending > 0) { challans = true; bits.push(`${pending} pending challan${pending === 1 ? '' : 's'}`); }
  for (const d of report.documentsOf(snap.rc || {})) {
    if (d.days < 0) expired.push(d.name);
    bits.push(d.days < 0 ? `${d.name} expired ${report.human(d.days)}` : `${d.name} valid till ${fmtDate(d.date)}`);
  }
  return { expired, challans, text: bits.length ? bits.join(' · ') : 'All clear — nothing new since the last check ✅' };
}

/** One pass. Safe to call as often as you like; it only acts on what is due. */
async function runOnce() {
  const started = Date.now();
  const list = await due();
  let sent = 0;

  let queued = 0;
  for (const w of list) {
    const r = await checkOne(w);
    if (r.queued) queued += r.items.length;
  }
  const digest = await eveningDigest();
  sent = digest.sent || 0;
  // After the real alerts, so anyone who just got one is skipped.
  sent += (await dailyStatus().catch((e) => { console.error('[watch] daily status:', e.message); return { sent: 0 }; })).sent || 0;
  const life = await lifecycle();

  if (list.length || sent || life.notified || life.renewals || life.expired) {
    console.log('[watch] checked %d, queued %d finding(s), evening messages %d, trial-notices %d, renewal-notices %d, expired %d (%dms)',
      list.length, queued, sent, life.notified, life.renewals, life.expired, Date.now() - started);
  }
  return { checked: list.length, queued, sent, ...life };
}

/** Start the loop. One timer, and it never overlaps itself. */
function start(everySeconds = 60) {
  let running = false;
  const tick = async () => {
    if (running) return;              // a slow pass must not stack on itself
    running = true;
    try { await runOnce(); } catch (e) { console.error('[watch] pass failed:', e.message); }
    finally { running = false; }
  };
  // Heartbeat: System health and the alert checker see when this last ran.
  setInterval(require('../util/heartbeat').wrap('watch', tick, everySeconds), everySeconds * 1000).unref();
  setTimeout(tick, 3000).unref();     // one pass shortly after boot
  console.log(`  watch job: every ${everySeconds}s`);
}

module.exports = { start, runOnce, checkOne, findings, lifecycle, due, eveningDigest, dailyStatus, statusLine, notify, alertMail };
