/**
 * src/jobs/watch.js
 * ---------------------------------------------------------------------------
 * The part that makes GaadiPe a service rather than a lookup.
 *
 * Every pass does three things, in this order:
 *
 *   1. re-check the vehicles that are due, and compare against what we last saw
 *   2. tell people what changed — one message per vehicle per day, never three
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

const MS_MIN = 60 * 1000;

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
            w.challan_interval_hours,
            v.reg_no, u.mobile, u.wa_profile_name, u.is_paused
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
 * Returns short phrases; the caller joins them with " · " because a template
 * variable may not contain a newline.
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
    out.push(`${n} new challan${n === 1 ? '' : 's'}`);
  } else if (now !== null && was === null && now > 0) {
    out.push(`${now} pending challan${now === 1 ? '' : 's'}`);
  }

  // Documents that have crossed into their warning window, or lapsed.
  for (const d of report.documentsOf(data.rc || {})) {
    const horizon = WARN_DAYS[d.label];
    if (horizon === undefined) continue;
    if (d.days < 0) out.push(`${d.label} expired ${report.human(d.days)}`);
    else if (d.days <= horizon) out.push(`${d.label} expires ${report.human(d.days)}`);
  }

  return out;
}

/**
 * Say it once. A document that expires in 30 days would otherwise produce the
 * same sentence every day for a month, which is how a useful service becomes
 * the thing someone mutes.
 */
async function alreadySaid(watchId, phrase) {
  const row = await db.one(
    `SELECT 1 FROM event_log
      WHERE kind = 'watch_alert'
        AND detail->>'watch_id' = $1
        AND detail->'items' ? $2
        AND created_at > now() - interval '7 days'
      LIMIT 1`, [String(watchId), phrase]);
  return Boolean(row);
}

async function checkOne(w) {
  let data;
  try {
    data = await gateway.full(w.reg_no);
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
  await store.record(w.user_id, data).catch(e => console.error('[watch] store:', e.message));

  const interval = await settings.num('watch_check_interval_minutes', 24 * 60);
  await db.query(
    `UPDATE watches
        SET last_checked_at = now(), fail_count = 0,
            challan_next_check_at = now() + ($2 || ' minutes')::interval,
            rc_next_check_at      = now() + ($2 || ' minutes')::interval,
            fastag_next_check_at  = now() + ($2 || ' minutes')::interval,
            modified_at = now()
      WHERE id = $1`, [w.id, String(interval)]);

  const fresh = [];
  for (const item of items) {
    if (!await alreadySaid(w.id, item)) fresh.push(item);
  }
  if (!fresh.length) return { sent: false, items };

  const summary = fresh.join(' · ');
  await notify(w, summary, data);
  await db.query(
    `INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'watch_alert', $3)`,
    [w.user_id, w.vehicle_id,
     JSON.stringify({ watch_id: String(w.id), reg_no: w.reg_no, items: fresh, summary })]);
  return { sent: true, items: fresh };
}

/**
 * Send the alert. Inside the 24-hour window a plain message is free and reads
 * better; outside it, only an approved template will deliver.
 */
async function notify(w, summary, data) {
  const name = (w.wa_profile_name || 'there').split(' ')[0];

  if (await send.windowOpen(w.mobile)) {
    await send.text(w.mobile,
      `🔔 *${w.reg_no}*\n\n${summary}\n\n`
      + 'Reply with this vehicle number to see the full record.');
    return;
  }

  const template = await settings.get('template_vehicle_alert', 'gp_watchalert_v1');
  await send.template(w.mobile, template, [name, w.reg_no, 'Needs attention', summary]);
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
    const name = (t.wa_profile_name || 'there').split(' ')[0];
    const price = Math.round(await settings.num('first_payment_paise', 4900) / 100);
    const when = new Date(t.expires_at);
    if (await send.windowOpen(t.mobile)) {
      await send.text(t.mobile,
        `Your free trial for *${t.reg_no}* ends on *${when.toDateString()}*.\n\n`
        + `To keep monitoring this vehicle, it is ₹${price} for 28 days. `
        + 'Nothing is charged automatically.');
    } else {
      const tpl = await settings.get('template_trial_ending', 'gp_trialending_v1');
      await send.template(t.mobile, tpl, [name, t.reg_no, String(price)]);
    }
    await db.query(
      `INSERT INTO event_log (user_id, kind, detail)
       SELECT user_id, 'trial_ending_notice', $2 FROM watches WHERE id = $1`,
      [t.id, JSON.stringify({ watch_id: String(t.id), reg_no: t.reg_no })]);
  }

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

  return { notified: ending.rowCount, expired: expired.rowCount };
}

/** One pass. Safe to call as often as you like; it only acts on what is due. */
async function runOnce() {
  const started = Date.now();
  const list = await due();
  let sent = 0;

  for (const w of list) {
    const r = await checkOne(w);
    if (r.sent) sent++;
  }
  const life = await lifecycle();

  if (list.length || life.notified || life.expired) {
    console.log('[watch] checked %d, alerted %d, notices %d, expired %d (%dms)',
      list.length, sent, life.notified, life.expired, Date.now() - started);
  }
  return { checked: list.length, sent, ...life };
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
  setInterval(tick, everySeconds * 1000).unref();
  setTimeout(tick, 3000).unref();     // one pass shortly after boot
  console.log(`  watch job: every ${everySeconds}s`);
}

module.exports = { start, runOnce, checkOne, findings, lifecycle, due };
