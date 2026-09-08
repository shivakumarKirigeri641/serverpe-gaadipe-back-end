/**
 * src/whatsapp/flow.js
 * ---------------------------------------------------------------------------
 * The conversation. One function decides what GaadiPe says next.
 *
 * State lives in whatsapp_sessions.state, never in memory, because a bot that
 * forgets where someone was when the server restarts is worse than no bot.
 *
 * STATES SO FAR
 *   new              nobody has spoken yet — anything gets the welcome
 *   main_menu        welcome sent, waiting for owner or partner
 *   owner_consent    owner chose; terms shown, waiting for agreement
 *   partner_consent  partner chose; partner policy shown, waiting for agreement
 *   owner_start      agreed — waiting for a vehicle number
 *   owner_confirm    a number was read; waiting for confirm or re-enter
 *   owner_lookup     confirmed; fetching from the gateway
 *   owner_menu       report sent; waiting for trial / check another
 *   trial_active     one or more vehicles are being watched
 *   checkout_review  order summary shown; waiting for agree-and-pay
 *   awaiting_payment a payment link was sent; waiting for the webhook
 *   partner_start    agreed — ready for the partner flow (next to build)
 *
 * WHY CONSENT IS ITS OWN STATE: agreement has to be a deliberate act with a
 * timestamp against it, not something buried in a welcome message nobody read.
 * The tap is recorded in event_log, so months later it can be shown exactly
 * when a given mobile number agreed and to which documents.
 *
 * Nothing in this file ever starts a conversation. Every message here is a
 * reply to something the person just sent — that is the product's rule, not
 * only Meta's: GaadiPe does not message anyone who has not messaged first.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');
const send = require('./send');
const plate = require('../util/plate');
const gateway = require('../vehicle/gateway');
const store = require('../vehicle/store');
const report = require('./report');
const settings = require('../util/settings');
const quota = require('../util/quota');
const razorpay = require('../pay/razorpay');
const billing = require('../pay/billing');

/* Button ids as constants: a typo'd string would silently fall through to
   "I did not understand" rather than failing loudly. */
const BTN = {
  OWNER: 'role_owner',
  PARTNER: 'role_partner',
  AGREE_OWNER: 'agree_owner',
  AGREE_PARTNER: 'agree_partner',
  PLATE_OK: 'plate_ok',
  PLATE_RETRY: 'plate_retry',
  TRIAL_START: 'trial_start',
  CHECK_ANOTHER: 'check_another',
  SUBSCRIBE: 'subscribe',
  ENROLLED: 'enrolled',
  WATCH_PICK: 'watch_pick',
  PAY_CONFIRM: 'pay_confirm',
};

const SITE = process.env.PUBLIC_SITE_URL || 'https://gaadipe.in';

const WELCOME =
  'Namaste! 🙏 This is *GaadiPe* — vehicle information and document alerts on WhatsApp.\n\n'
  + 'Check any vehicle\'s RC, insurance, PUC, fitness, permit, challans and FASTag — '
  + 'and get reminded *before* something expires or a new challan appears.\n\n'
  + 'What brings you here?';

const OWNER_TERMS =
  'Before we begin, please read how GaadiPe works:\n\n'
  + `📄 Terms of Service\n${SITE}/terms\n\n`
  + `🔒 Privacy Policy\n${SITE}/privacy\n\n`
  + `💳 Refund Policy\n${SITE}/refund\n\n`
  + 'In short: GaadiPe shows Government-sourced vehicle records as they are. '
  + 'We do not show owner name, chassis or engine number. We never message you '
  + 'unless you message us first, or you have subscribed to alerts.\n\n'
  + 'Tap below to continue.';

const PARTNER_TERMS =
  'Good to have you! 🤝 Please read the partner terms first:\n\n'
  + `📄 Partner Commission & Payout Policy\n${SITE}/partner-policy\n\n`
  + `🔒 Privacy Policy\n${SITE}/privacy\n\n`
  + 'In short: you earn *₹5 per vehicle* when someone you introduce makes their '
  + 'first payment, and *₹3 per vehicle* on every renewal, for as long as they stay. '
  + 'There is no joining fee, no target, and no earning from enrolling other partners.\n\n'
  + 'Tap below to continue.';

/**
 * What did the person actually do? A tapped button arrives as an interactive
 * reply carrying the id we set; typed text arrives as text. Normalising both to
 * one shape keeps the routing readable.
 */
function intentOf(m) {
  if (m.type === 'interactive') {
    const r = m.interactive?.button_reply || m.interactive?.list_reply || {};
    return { kind: 'button', id: r.id, text: r.title || '' };
  }
  if (m.type === 'button') return { kind: 'button', id: m.button?.payload, text: m.button?.text || '' };
  return { kind: 'text', id: null, text: (m.text?.body || '').trim() };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (d) => `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/**
 * A 7-day trial ends on a date; a 1-minute test trial ends at a time. Showing
 * "15 Sep 2026" for something that expires in sixty seconds would make the test
 * look broken, so the precision follows the length.
 */
const until = (d, minutes) => (minutes < 24 * 60
  ? `${fmt(d)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  : fmt(d));

const setState = (mobile, state, reason) => db.query(
  `UPDATE whatsapp_sessions SET state = $2, state_reason = $3, modified_at = now()
    WHERE mobile = $1`, [mobile, state, reason || null]);

/**
 * Record an agreement. Kept in event_log rather than a column so the record is
 * append-only: a later agreement adds a row, it does not overwrite the proof of
 * an earlier one.
 */
async function recordConsent(mobile, role, documents) {
  const session = await db.one(
    `SELECT id, user_id FROM whatsapp_sessions WHERE mobile = $1`, [mobile]);
  await db.query(
    `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'consent_accepted', $2)`,
    [session?.user_id || null,
     JSON.stringify({ mobile, role, documents, channel: 'whatsapp',
                      policy_version: await policyVersion(),
                      at: new Date().toISOString() })]);
  await db.query(
    `UPDATE whatsapp_sessions
        SET context = context || $2::jsonb, modified_at = now()
      WHERE mobile = $1`,
    [mobile, JSON.stringify({ role, consent_at: new Date().toISOString(), consent_documents: documents })]);
  console.log('[wa] consent %s by %s', role, mobile);
}

/**
 * The version of the customer-facing policies as they stand today.
 *
 * WHY VERSION AND NOT TIME: an agreement does not go stale because months
 * passed — it goes stale when what was agreed to changes. Re-asking every 90
 * days adds friction for the people who use GaadiPe most and proves nothing;
 * re-asking when the Terms actually change is the only moment a fresh tap means
 * anything. The prices moved from Rs.99 to Rs.59 today, which is exactly the
 * kind of change that should require one.
 */
async function policyVersion() {
  const row = await db.one(
    `SELECT max(v) AS version FROM (
       SELECT max(version) AS v FROM terms_and_conditions WHERE is_active
       UNION ALL SELECT max(version) FROM privacy_policy WHERE is_active
       UNION ALL SELECT max(version) FROM refund_policy   WHERE is_active
     ) x`);
  return row?.version || '1.0';
}

/** What this person last agreed to, if anything. */
async function agreedVersion(mobile) {
  const row = await db.one(
    `SELECT detail->>'policy_version' AS version
       FROM event_log
      WHERE kind = 'consent_accepted' AND detail->>'mobile' = $1
      ORDER BY id DESC LIMIT 1`, [mobile]);
  return row?.version || null;
}

/**
 * Has this person ever had a trial? Read from event_log rather than from
 * watches, because a watch row is deleted or deactivated over time while the
 * event is permanent — and "one trial per mobile number, ever" is a promise
 * about all of history, not about current state.
 */
async function trialUsed(userId) {
  const row = await db.one(
    `SELECT 1 FROM event_log WHERE kind = 'trial_started' AND user_id = $1 LIMIT 1`,
    [userId]);
  return Boolean(row);
}

/** Whatever the session is carrying between messages. */
async function sessionContext(mobile) {
  const row = await db.one(
    `SELECT context FROM whatsapp_sessions WHERE mobile = $1`, [mobile]);
  return row?.context || {};
}

/**
 * Add a vehicle to the free trial, starting the trial if this is the first.
 *
 * The rules, and the reason each exists:
 *
 *   one trial per mobile number, ever — otherwise it is not a trial
 *   up to trial_vehicles vehicles     — same cap as the paid plan, so there is
 *                                       one number to remember
 *   ONE CLOCK for the whole trial     — the trial ends trial_minutes after the
 *                                       FIRST vehicle was added, not after each
 *
 * That last rule is what makes a multi-vehicle trial safe. Per-vehicle clocks
 * would let someone add a plate every few days and never reach the end.
 *
 * A single-vehicle trial can be a silent week: if nothing expires and no challan
 * arrives, the customer concludes the service does nothing. Several vehicles
 * make it far likelier that something real surfaces, and one genuine "PUC
 * expired 4 months ago" sells the product better than any explanation.
 *
 * Conversion stays per vehicle, so nobody is ever shown ₹196 as one number —
 * which is what made a one-vehicle trial worth having in the first place.
 *
 * trial_minutes is a setting, so a test run sets it to 1 and watches the whole
 * lifecycle — check, notice, expiry — in a couple of minutes, running exactly
 * the code production runs.
 */
async function startTrial(userId, regNo) {
  const vehicle = await db.one(`SELECT id FROM vehicles WHERE reg_no = $1`, [regNo]);
  if (!vehicle) return { ok: false, reason: 'unknown_vehicle' };

  const minutes = await settings.num('trial_minutes', 7 * 24 * 60);
  const maxVehicles = await settings.num('trial_vehicles', 4);
  const checkEvery = await settings.num('watch_check_interval_minutes', 24 * 60);

  const prior = await db.one(
    `SELECT detail->>'started_at' AS started_at
       FROM event_log
      WHERE kind = 'trial_started' AND user_id = $1
      ORDER BY id LIMIT 1`, [userId]);

  // One clock for the whole trial: it ends trial_minutes after the FIRST
  // vehicle was added, whatever is added later.
  const startedAt = prior?.started_at ? new Date(prior.started_at) : new Date();
  const endsAt = new Date(startedAt.getTime() + minutes * 60 * 1000);

  // A trial that has already run its course cannot be topped up with a new
  // vehicle — that would be a second trial wearing the first one's name.
  if (prior && endsAt <= new Date()) return { ok: false, reason: 'trial_over' };

  const active = await db.one(
    `SELECT count(*)::int AS n FROM watches
      WHERE user_id = $1 AND is_active AND vehicle_id <> $2`, [userId, vehicle.id]);
  if (active.n >= maxVehicles) return { ok: false, reason: 'limit', max: maxVehicles };

  const first = !prior;

  await db.tx(async (c) => {
    await c.query(
      `INSERT INTO watches (user_id, vehicle_id, expires_on, expires_at,
                            challan_next_check_at, rc_next_check_at, fastag_next_check_at,
                            challan_interval_hours, rc_interval_hours, fastag_interval_hours)
            VALUES ($1, $2, $3, $4,
                    now() + ($5 || ' minutes')::interval,
                    now() + ($5 || ' minutes')::interval,
                    now() + ($5 || ' minutes')::interval,
                    $6, $6, $6)
       ON CONFLICT (user_id, vehicle_id) DO UPDATE
              SET is_active = true, expires_on = EXCLUDED.expires_on,
                  expires_at = EXCLUDED.expires_at, modified_at = now()`,
      [userId, vehicle.id, endsAt.toISOString().slice(0, 10), endsAt.toISOString(),
       String(checkEvery), Math.max(1, Math.round(checkEvery / 60))]);
    await c.query(
      `INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, $3, $4)`,
      [userId, vehicle.id, first ? 'trial_started' : 'trial_vehicle_added',
       JSON.stringify({ reg_no: regNo,
                        started_at: startedAt.toISOString(),
                        ends_at: endsAt.toISOString(),
                        trial_minutes: minutes })]);
    await c.query(
      `UPDATE user_vehicles SET relation = 'owned'
        WHERE user_id = $1 AND vehicle_id = $2`, [userId, vehicle.id]);
  });

  return { ok: true, first, endsAt, minutes,
           watching: active.n + 1, slotsLeft: maxVehicles - active.n - 1 };
}

/** The number the person last sent, held on the session until confirmed. */
async function pendingReg(mobile) {
  const row = await db.one(
    `SELECT context->>'pending_reg' AS reg FROM whatsapp_sessions WHERE mobile = $1`, [mobile]);
  return row?.reg || null;
}

/**
 * Read a number back before spending a lookup on it.
 *
 * WHY CONFIRM AT ALL: one wrong character is a different vehicle that may well
 * exist, so the answer comes back looking perfectly valid and is simply about
 * someone else's car. A lookup is cheap today and will not always be.
 *
 * People may type it however they like — "ka 02 ex 1480", "KA02-EX-1480" — but
 * what is read back is the registration as it is actually written: KA02EX1480,
 * upper case, no separators. That is the string that goes to the RTO records,
 * so it is the string they should be agreeing to.
 */
async function askToConfirm(mobile, parsed) {
  await db.query(
    `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now()
      WHERE mobile = $1`,
    [mobile, JSON.stringify({ pending_reg: parsed.regNo })]);
  await setState(mobile, 'owner_confirm', 'awaiting confirmation');

  const note = parsed.repaired
    ? '\n\n_I have read this from what you sent — please check it carefully._'
    : '';
  await send.buttons(mobile,
    `You entered:\n\n*${parsed.regNo}*${note}\n\nIs this correct?`,
    [{ id: BTN.PLATE_OK,    title: 'Confirm' },
     { id: BTN.PLATE_RETRY, title: 'Re-enter number' }]);
}

/**
 * Offer the vehicles this person has already checked, as a list.
 *
 * WHY: someone eight vehicles into a trial should not be retyping plates off a
 * registration book on a phone keyboard. The list costs no lookup — every plate
 * and every expiry date shown is already in our database — and the description
 * line carries the reason to tap, which a bare list of numbers does not.
 *
 * Returns false when there is nothing worth showing, so the caller can fall
 * back to asking them to type.
 */
async function offerKnownVehicles(mobile, userId, { body, button } = {}) {
  const known = await store.checkedBy(userId, 9);
  if (known.length < 2) return false;

  const rows = known.map(v => {
    const docs = report.documentsOf({
      insurance_upto: v.insurance_upto, pucc_upto: v.pucc_upto,
      fitness_upto: v.fitness_upto, tax_upto: v.tax_upto, permit_upto: v.permit_upto,
      vehicle_class: v.vehicle_class,
    });

    // The most urgent thing about this vehicle: anything expired, else anything
    // close, else simply whatever runs out next. A manufacturer's name tells
    // someone nothing they do not already know about their own vehicle.
    const expired = docs.filter(d => d.days < 0).sort((a, b) => a.days - b.days)[0];
    const soon = docs.filter(d => d.days >= 0 && d.days <= 30).sort((a, b) => a.days - b.days)[0];
    const next = docs.filter(d => d.days > 30).sort((a, b) => a.days - b.days)[0];

    const status = expired ? `${expired.label} expired ${report.human(expired.days)}`
      : soon ? `${soon.label} expires ${report.human(soon.days)}`
      : next ? `${next.label} valid ${report.human(next.days).replace('in ', 'for ')}`
      : 'Tap to check';
    return {
      id: `veh:${v.reg_no}`,
      title: v.reg_no,
      description: v.watched ? `Watching · ${status}` : status,
    };
  });

  await send.list(mobile, {
    body: body || 'Which vehicle would you like to check?',
    button: button || 'Choose vehicle',
    sectionTitle: 'Recently checked',
    rows,
    footer: 'Or just send a different vehicle number.',
  });
  return true;
}

/**
 * "Which of these should I keep an eye on?"
 *
 * Checking is casual and high-volume — someone at a dealer's yard runs through
 * eight plates in two minutes. Watching is a deliberate choice about one or two
 * of them, made afterwards. Asking them to retype a plate they checked five
 * minutes ago, to select it, is the kind of small friction that loses the sale.
 *
 * So the list is built from what they have already checked, minus what is
 * already watched, with the reason to choose each one on its own line.
 */
async function offerToWatch(mobile, userId) {
  const known = await store.checkedBy(userId, 9);
  const candidates = known.filter(v => !v.watched);
  if (!candidates.length) return false;

  const rows = candidates.map(v => {
    const docs = report.documentsOf({
      insurance_upto: v.insurance_upto, pucc_upto: v.pucc_upto,
      fitness_upto: v.fitness_upto, tax_upto: v.tax_upto, permit_upto: v.permit_upto,
      vehicle_class: v.vehicle_class,
    });
    const expired = docs.filter(d => d.days < 0).sort((a, b) => a.days - b.days)[0];
    const soon = docs.filter(d => d.days >= 0 && d.days <= 60).sort((a, b) => a.days - b.days)[0];
    const next = docs.filter(d => d.days > 60).sort((a, b) => a.days - b.days)[0];
    return {
      id: `watch:${v.reg_no}`,
      title: v.reg_no,
      description: expired ? `${expired.label} expired ${report.human(expired.days)}`
        : soon ? `${soon.label} expires ${report.human(soon.days)}`
        : next ? `${next.label} valid ${report.human(next.days).replace('in ', 'for ')}`
        : 'No dates on record',
    };
  });

  await send.list(mobile, {
    body: 'Which vehicle should I keep watching?\n\n'
      + 'I will check it every day and message you when a new challan appears '
      + 'or a document is close to expiring.',
    button: 'Choose vehicle',
    sectionTitle: 'Vehicles you checked',
    rows,
    footer: 'Pick one at a time — you can add more after.',
  });
  return true;
}

/**
 * What GaadiPe is currently watching for this person, and until when.
 *
 * Someone three vehicles in cannot hold the end dates in their head, and asking
 * them to remember which plates they enrolled defeats the point of enrolling
 * them. Reads entirely from our own tables — no lookup, no cost.
 */
async function showEnrolled(mobile, userId) {
  const watching = await store.watchedBy(userId);
  if (!watching.length) return false;

  const lines = watching.map(w => {
    const ends = w.expires_on ? fmt(new Date(w.expires_on)) : 'ongoing';
    const paid = w.subscription_id ? 'Paid' : 'Free trial';
    return `• *${w.reg_no}* — ${paid}, until ${ends}`;
  });

  const max = await settings.num('trial_vehicles', 4);
  const slots = max - watching.length;

  await send.buttons(mobile,
    `You are watching ${watching.length} vehicle${watching.length === 1 ? '' : 's'}:\n\n`
    + lines.join('\n')
    + (slots > 0
        ? `\n\nYou can add ${slots} more — just send me the number.`
        : '\n\nThat is the maximum for one number.')
    + '\n\nI check them every day and message you only when something needs attention.',
    [{ id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
  return true;
}

/**
 * Send their tax invoices back.
 *
 * ALWAYS AVAILABLE, even after a subscription lapses. An invoice is the
 * customer's own tax record for money they actually paid; refusing to hand it
 * over because a plan expired would be indefensible, and in India it may be
 * something they need years later.
 */
async function sendInvoices(mobile) {
  const user = await store.upsertUser(mobile);
  const { rows } = await db.query(
    `SELECT i.invoice_number, i.pdf_path, i.total_paise, i.invoice_date, v.reg_no
       FROM invoices i
       LEFT JOIN subscriptions s ON s.id = i.subscription_id
       LEFT JOIN vehicles v ON v.id = s.vehicle_id
      WHERE i.user_id = $1
      ORDER BY i.id DESC LIMIT 3`, [user.id]);

  if (!rows.length) {
    await send.text(mobile,
      'You do not have any invoices yet — they are issued when a payment is made.');
    return;
  }

  for (const inv of rows) {
    const caption = `🧾 ${inv.invoice_number}`
      + `${inv.reg_no ? ` — ${inv.reg_no}` : ''} · ₹${(inv.total_paise / 100).toFixed(2)}`;
    const sent = inv.pdf_path
      ? await send.document(mobile, inv.pdf_path,
          { filename: `${inv.invoice_number}.pdf`, caption })
      : { ok: false };
    if (!sent.ok) await send.text(mobile, caption + '\n_The file could not be attached._');
  }
}

/**
 * Send their vehicle reports back.
 *
 * A REPORT IS VALID FOR AS LONG AS THE SUBSCRIPTION IS. Unlike an invoice, this
 * is the product rather than a record of a purchase: handing over last month's
 * report to someone who stopped paying would be giving away what they stopped
 * paying for. When the plan has lapsed, they are offered a renewal instead.
 */
async function sendReports(mobile) {
  const user = await store.upsertUser(mobile);
  const { rows } = await db.query(
    `SELECT r.report_number, r.pdf_path, r.reg_no, r.created_at,
            s.ends_on, s.is_active
       FROM vehicle_reports r
       LEFT JOIN subscriptions s ON s.id = r.subscription_id
      WHERE r.user_id = $1
      ORDER BY r.id DESC LIMIT 4`, [user.id]);

  if (!rows.length) {
    await send.text(mobile,
      'You do not have any saved reports yet.\n\n'
      + 'Send me a vehicle number to check it, and a full report is issued when you subscribe.');
    return;
  }

  const live = rows.filter(r => r.is_active && r.ends_on && new Date(r.ends_on) >= new Date());
  const lapsed = rows.filter(r => !live.includes(r));

  for (const r of live) {
    const sent = r.pdf_path
      ? await send.document(mobile, r.pdf_path,
          { filename: `${r.report_number}.pdf`,
            caption: `📋 ${r.report_number} — ${r.reg_no} · valid until ${fmt(new Date(r.ends_on))}` })
      : { ok: false };
    if (!sent.ok) {
      await send.text(mobile,
        `📋 ${r.report_number} — ${r.reg_no}\n_The file could not be attached._`);
    }
  }

  if (lapsed.length && !live.length) {
    const price = Math.round(await settings.num('first_payment_paise', 5900) / 100);
    await setState(mobile, 'owner_menu', 'reports lapsed');
    await send.buttons(mobile,
      `Your report for *${lapsed[0].reg_no}* was issued with a plan that has now ended, `
      + 'so it is no longer available.\n\n'
      + `Renew for ₹${price} and I will issue a fresh report with today's records.`,
      [{ id: BTN.SUBSCRIBE,     title: `Continue for ₹${price}` },
       { id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
  }
}

/**
 * What to say when someone runs out of checks.
 *
 * Never a bare "limit exceeded". A wall is also a door: the person who has just
 * looked up twenty vehicles is more interested than anyone else who messaged
 * today, so the message points at the next step rather than at the rule.
 */
async function quotaMessage(q) {
  if (q.reason === 'burst') {
    return 'That is a lot of checks very quickly — please wait a minute and '
      + 'send the number again.';
  }
  const days = Math.round(await settings.num('trial_minutes', 10080) / (60 * 24)) || 1;
  if (q.tier === 'trial') {
    return `You have used today's ${q.limit} free checks — they reset tomorrow.\n\n`
      + 'The vehicles on your trial are still being checked automatically every day.';
  }
  return `You have used your ${q.limit} free checks for today — they reset tomorrow.\n\n`
    + `Start a free ${days}-day trial and I will check your vehicles automatically, `
    + 'and message you the moment something needs attention.';
}

/**
 * Fetch the vehicle, send the report, and offer whatever comes next.
 *
 * WHAT "NEXT" IS DEPENDS ON WHAT THEY ALREADY HAVE, which is why the watch list
 * is read before the buttons are chosen. Offering "start your free trial" to
 * someone whose trial is already running on another vehicle is the kind of
 * detail that makes a bot feel like a form rather than a service.
 */
async function deliverReport(mobile, regNo, message) {
  const user = await store.upsertUser(mobile, {
    name: message?.profile?.name, waId: message?.from,
  });

  // Asked before the call, not after: the point is to not spend the lookup.
  const q = await quota.check(user.id, regNo);
  if (!q.allowed) {
    await setState(mobile, 'owner_menu', `quota ${q.reason}`);
    await send.buttons(mobile, await quotaMessage(q),
      q.tier === 'stranger'
        ? [{ id: BTN.TRIAL_START, title: 'Start free trial' }]
        : [{ id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
    return;
  }
  if (!q.repeat && q.limit && q.used + 1 >= q.limit) {
    console.warn('[quota] %s at %d/%d (%s)', mobile, q.used + 1, q.limit, q.tier);
  }

  let data;
  try {
    data = await gateway.full(regNo);
  } catch (e) {
    console.error('[wa] lookup failed for %s: %s', regNo, e.message);
    data = null;
  }

  await quota.record(user.id, regNo,
    { repeat: q.repeat, found: data?.success === true });

  if (!data || data.success !== true) {
    const notFound = data?.error === 'vehicle_not_found';
    await setState(mobile, 'owner_start', notFound ? 'vehicle not found' : 'lookup failed');
    await send.text(mobile, notFound
      ? `I could not find any Government record for *${regNo}*.\n\n`
        + 'Please check the number and send it again. Very new vehicles can take '
        + 'a few weeks to appear.'
      : 'Sorry, the vehicle service is busy right now. Please send the number '
        + 'again in a minute.');
    return;
  }

  // Recorded before it is sent: if the send fails we still know what we found.
  await store.record(user.id, data).catch(e => console.error('[wa] store failed:', e.message));

  /* ------------------------------------------------------------- paywall */

  // Once the trial is over and nothing is being watched, the details stop.
  //
  // A free trial that quietly becomes free forever is not a trial, and someone
  // who has already seen what the service does has had the demonstration. What
  // is still shown is the vehicle they typed and HOW MANY things need
  // attention — enough to know it matters, not enough to act on without paying.
  const watchingNow = await store.watchedBy(user.id);
  const paying = await db.one(
    `SELECT 1 FROM subscriptions WHERE user_id = $1 AND is_active LIMIT 1`, [user.id]);
  const paywalled = await trialUsed(user.id) && !watchingNow.length && !paying;

  if (paywalled) {
    const price = Math.round(await settings.num('first_payment_paise', 5900) / 100);
    const docs = report.documentsOf(data.rc || {});
    const bad = docs.filter(d => d.days < 0).length;
    const soon = docs.filter(d => d.days >= 0 && d.days <= 60).length;
    const challans = data.challans?.pending_count || 0;
    const issues = bad + soon + (challans > 0 ? 1 : 0);

    await setState(mobile, 'owner_menu', 'paywalled after trial');
    await send.buttons(mobile,
      `🔒 *${regNo}*\n\n`
      + (issues
          ? `I found *${issues} thing${issues === 1 ? '' : 's'}* that need${issues === 1 ? 's' : ''} attention on this vehicle.\n\n`
          : 'I have this vehicle\'s full record.\n\n')
      + 'Your free trial has ended, so the details are no longer shown.\n\n'
      + `Watch this vehicle for ₹${price} — 28 days of daily checks, the full report now, `
      + 'and a message whenever something changes.',
      [{ id: BTN.SUBSCRIBE,     title: `Continue for ₹${price}` },
       { id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
    return;
  }

  // Detail is what the subscription buys, so it follows the subscription for
  // THIS vehicle — not for the customer generally.
  const paidForThis = await db.one(
    `SELECT 1 FROM subscriptions s
       JOIN vehicles v ON v.id = s.vehicle_id
      WHERE s.user_id = $1 AND v.reg_no = $2 AND s.is_active
        AND s.ends_on >= CURRENT_DATE
      LIMIT 1`, [user.id, regNo]);

  await send.text(mobile, await report.buildFor(data, { detailed: Boolean(paidForThis) }));

  const watching = await store.watchedBy(user.id);
  const already = watching.find(w => w.reg_no === regNo);

  if (already) {
    await setState(mobile, 'owner_menu', 'already watching this vehicle');
    await send.buttons(mobile,
      `You are already watching *${regNo}*. I will message you if anything changes.`,
      [{ id: BTN.CHECK_ANOTHER, title: 'Check another' }]);
    return;
  }

  // Someone whose trial has already run is not offered another one. Being
  // offered a "free trial" you cannot have, and finding out only after tapping,
  // is worse than not being offered it at all.
  const used = await trialUsed(user.id);
  const days = Math.round(await settings.num('trial_minutes', 10080) / (60 * 24)) || 1;
  const price = Math.round(await settings.num('first_payment_paise', 4900) / 100);
  const maxVehicles = await settings.num('trial_vehicles', 4);

  await setState(mobile, 'owner_menu', 'report delivered');

  // Mid-trial, checking a vehicle that is not being watched: offer to add it.
  if (used && watching.length) {
    if (watching.length >= maxVehicles) {
      await send.buttons(mobile,
        `Your free trial already covers ${maxVehicles} vehicles `
        + `(${watching.map(w => w.reg_no).join(', ')}), which is the maximum.\n\n`
        + 'Checking any vehicle stays free — send me a number any time.',
        [{ id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
      return;
    }
    const left = maxVehicles - watching.length;
    await send.buttons(mobile,
      `Would you like me to watch *${regNo}* as well?\n\n`
      + `You are already watching ${watching.map(w => w.reg_no).join(', ')}. `
      + `Your free trial covers up to ${maxVehicles} vehicles — `
      + `${left} slot${left === 1 ? '' : 's'} left, and it ends on the same day either way.`,
      [{ id: BTN.TRIAL_START,   title: 'Add to free trial' },
       { id: BTN.ENROLLED,      title: 'Enrolled vehicles' },
       { id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
    return;
  }

  if (used) {
    await send.buttons(mobile,
      `Would you like me to keep watching *${regNo}*?\n\n`
      + `You have already used your free trial, so this is ₹${price} for 28 days — `
      + 'daily checks, and a message whenever a new challan appears or a document '
      + 'is close to expiring.\n\n'
      + 'Nothing is charged automatically.',
      [{ id: BTN.SUBSCRIBE,     title: `Continue for ₹${price}` },
       { id: BTN.CHECK_ANOTHER, title: 'Check another' }]);
    return;
  }

  await send.buttons(mobile,
    'Would you like me to keep watching this vehicle?\n\n'
    + `Free for ${days} day${days === 1 ? '' : 's'} — I check every day and message you `
    + 'if a new challan appears or a document is about to expire.\n\n'
    + `You can add up to ${maxVehicles} vehicles to the trial.`,
    [{ id: BTN.TRIAL_START,   title: 'Start free trial' },
     { id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
}

async function welcome(mobile) {
  await send.buttons(mobile, WELCOME, [
    { id: BTN.OWNER,   title: 'Check my vehicle' },
    { id: BTN.PARTNER, title: 'Earn with GaadiPe' },
  ], { footer: 'ServerPe App Solutions' });
  await setState(mobile, 'main_menu', 'welcome sent');
}

/**
 * @param {{id:number, state:string}} session  the row store.js just upserted
 * @param {object} message                     the raw WhatsApp message
 * @param {string} mobile                      10 digits
 */
async function handle(session, message, mobile) {
  const intent = intentOf(message);
  const state = session.state || 'new';

  // A tapped button is unambiguous wherever it arrives from, so it is routed
  // before the state machine rather than inside every branch of it.
  if (intent.kind === 'button') {
    // A list row carries the plate in its id. It was chosen from their own
    // history rather than typed, so there is nothing to mis-read and nothing
    // to confirm — go straight to the lookup.
    if (String(intent.id || '').startsWith('watch:')) {
      const reg = intent.id.slice(6);
      const user = await store.upsertUser(mobile);
      await db.query(
        `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now()
          WHERE mobile = $1`, [mobile, JSON.stringify({ pending_reg: reg })]);

      // Trial available -> start watching now. Trial used -> it costs money,
      // and the price decision belongs in one place, so reuse it.
      if (!await trialUsed(user.id)) {
        await handle({ state: 'owner_menu' },
          { type: 'interactive', interactive: { button_reply: { id: BTN.TRIAL_START } } }, mobile);
      } else {
        await handle({ state: 'owner_menu' },
          { type: 'interactive', interactive: { button_reply: { id: BTN.SUBSCRIBE } } }, mobile);
      }
      return;
    }

    if (String(intent.id || '').startsWith('veh:')) {
      const reg = intent.id.slice(4);
      await db.query(
        `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now()
          WHERE mobile = $1`, [mobile, JSON.stringify({ pending_reg: reg })]);
      await setState(mobile, 'owner_lookup', 'chosen from list');
      await send.text(mobile, `Checking *${reg}* … ⏳`);
      await deliverReport(mobile, reg, message);
      return;
    }

    switch (intent.id) {
      case BTN.OWNER:
        await setState(mobile, 'owner_consent', 'chose owner');
        await send.buttons(mobile, OWNER_TERMS,
          [{ id: BTN.AGREE_OWNER, title: 'Agree & continue' }]);
        return;

      case BTN.PARTNER:
        await setState(mobile, 'partner_consent', 'chose partner');
        await send.buttons(mobile, PARTNER_TERMS,
          [{ id: BTN.AGREE_PARTNER, title: 'Agree & continue' }]);
        return;

      case BTN.AGREE_OWNER:
        await recordConsent(mobile, 'owner', ['terms', 'privacy', 'refund']);
        await setState(mobile, 'owner_start', 'consent given');
        await send.text(mobile,
          'Thank you. ✅\n\n'
          + 'Send me the vehicle number you want to check.\n\n'
          + 'For example: *KA31N8147*');
        return;

      case BTN.AGREE_PARTNER:
        await recordConsent(mobile, 'partner', ['partner-policy', 'privacy']);
        await setState(mobile, 'partner_start', 'consent given');
        await send.text(mobile,
          'Thank you. ✅ You have agreed to the partner terms.\n\n'
          + 'Your partner account is being set up. Reply *hi* any time to start again.');
        return;

      case BTN.PLATE_OK: {
        const pending = await pendingReg(mobile);
        if (!pending) {           // context lost, or a stale button tapped twice
          await setState(mobile, 'owner_start', 'no pending number');
          await send.text(mobile, 'Please send the vehicle number again.');
          return;
        }
        await setState(mobile, 'owner_lookup', 'number confirmed');
        await send.text(mobile,
          `Checking *${pending}* … ⏳\n\nThis takes a few seconds.`);
        await deliverReport(mobile, pending, message);
        return;
      }

      case BTN.WATCH_PICK: {
        const user = await store.upsertUser(mobile);
        const offered = await offerToWatch(mobile, user.id);
        if (!offered) {
          await setState(mobile, 'owner_start', 'nothing left to watch');
          await send.text(mobile,
            'You are already watching every vehicle you have checked.\n\n'
            + 'Send me another vehicle number to check it first.');
        }
        return;
      }

      case BTN.ENROLLED: {
        const user = await store.upsertUser(mobile);
        const shown = await showEnrolled(mobile, user.id);
        if (!shown) {
          await setState(mobile, 'owner_start', 'nothing enrolled');
          await send.text(mobile,
            'You are not watching any vehicle yet.\n\n'
            + 'Send me a vehicle number and I will check it for you.');
        }
        return;
      }

      case BTN.CHECK_ANOTHER: {
        await setState(mobile, 'owner_start', 'checking another');
        const user = await store.upsertUser(mobile);
        const offered = await offerKnownVehicles(mobile, user.id, {
          body: 'Which vehicle would you like to check?',
          button: 'Choose vehicle',
        });
        if (!offered) await send.text(mobile, 'Sure — send me the next vehicle number.');
        return;
      }

      /**
       * The order summary — everything they are agreeing to, before any
       * payment page opens.
       *
       * WhatsApp has no checkbox, so the TAP is the consent. That is stronger
       * evidence than a tick, not weaker: it is recorded in event_log with the
       * amount, the vehicle, the policy versions and the timestamp, and a
       * button cannot be pre-ticked by us.
       */
      case BTN.SUBSCRIBE: {
        const user = await store.upsertUser(mobile);
        const reg = await pendingReg(mobile);
        const vehicle = reg
          ? await db.one(`SELECT id, reg_no, maker, model FROM vehicles WHERE reg_no = $1`, [reg])
          : null;

        if (!vehicle) {
          await setState(mobile, 'owner_start', 'no vehicle to pay for');
          await send.text(mobile, 'Please send the vehicle number you would like to watch.');
          return;
        }

        const { plan, paise, kind } = await billing.priceFor(user.id, vehicle.id);
        const gross = paise / 100;
        const taxable = gross / 1.18;
        const gst = gross - taxable;

        await db.query(
          `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now()
            WHERE mobile = $1`,
          [mobile, JSON.stringify({ pay_reg: vehicle.reg_no, pay_paise: paise, pay_kind: kind })]);
        await setState(mobile, 'checkout_review', 'summary shown');

        await send.buttons(mobile,
          '🧾 *Order summary*\n\n'
          + `Vehicle: *${vehicle.reg_no}*`
          + `${vehicle.maker ? `\n${[vehicle.maker, vehicle.model].filter(Boolean).join(' ').slice(0, 40)}` : ''}\n`
          + `Plan: GaadiPe Watch · ${plan.duration_days} days\n`
          + `${kind === 'renewal' ? 'Renewal' : 'First payment'}\n\n`
          + '━━━━━━━━━━━━━━━\n'
          + `Amount        ₹${taxable.toFixed(2)}\n`
          + `GST @18%      ₹${gst.toFixed(2)}\n`
          + `*Total        ₹${gross.toFixed(2)}*\n`
          + '━━━━━━━━━━━━━━━\n\n'
          + 'What you get: daily checks, new-challan alerts, and reminders before '
          + 'insurance, PUC or fitness expires.\n\n'
          + `📄 ${SITE}/terms\n💳 ${SITE}/refund\n🔒 ${SITE}/privacy\n\n`
          + '*No auto-renewal.* Nothing is charged automatically, now or later.\n\n'
          + 'By tapping *Agree & pay* you accept the Terms, Refund and Privacy policies.',
          [{ id: BTN.PAY_CONFIRM, title: `Agree & pay ₹${Math.round(gross)}` },
           { id: BTN.CHECK_ANOTHER, title: 'Not now' }]);
        return;
      }

      case BTN.PAY_CONFIRM: {
        const user = await store.upsertUser(mobile);
        const ctx = await sessionContext(mobile);
        const vehicle = ctx.pay_reg
          ? await db.one(`SELECT id, reg_no FROM vehicles WHERE reg_no = $1`, [ctx.pay_reg])
          : null;

        if (!vehicle) {
          await setState(mobile, 'owner_start', 'checkout lost');
          await send.text(mobile, 'Please send the vehicle number again.');
          return;
        }
        if (!razorpay.configured()) {
          await send.text(mobile,
            'Payment is not available right now. Please try again shortly.');
          console.error('[pay] asked to charge but Razorpay is not configured');
          return;
        }

        // Recorded before the link exists, so the agreement stands even if the
        // payment never happens.
        await db.query(
          `INSERT INTO event_log (user_id, vehicle_id, kind, detail)
                VALUES ($1, $2, 'purchase_consent', $3)`,
          [user.id, vehicle.id,
           JSON.stringify({ mobile, reg_no: vehicle.reg_no, amount_paise: ctx.pay_paise,
                            kind: ctx.pay_kind, documents: ['terms', 'refund', 'privacy'],
                            at: new Date().toISOString() })]);

        const { plan, paise, kind } = await billing.priceFor(user.id, vehicle.id);
        const row = await billing.createPending({
          userId: user.id, planId: plan.id, amountPaise: paise, vehicleId: vehicle.id,
        });

        // An ORDER, not a payment link. A link ends on Razorpay's own page and
        // tells us nothing until a webhook arrives; an order opened by Checkout
        // inside our page gives the browser a signed success callback, so the
        // subscription is active before they are back in this chat.
        let order;
        try {
          order = await razorpay.createOrder({
            amountPaise: paise,
            receipt: `gp-${row.id}`,
            notes: { reg_no: vehicle.reg_no, mobile, kind, payment_row: String(row.id) },
          });
        } catch (e) {
          console.error('[pay] order creation failed:', e.message);
          await send.text(mobile,
            'Sorry, I could not start the payment just now. Please try again in a minute.');
          return;
        }

        const token = require('crypto').randomBytes(16).toString('hex');
        await db.query(
          `UPDATE payments SET order_id = $2, checkout_token = $3,
                  raw = COALESCE(raw,'{}'::jsonb) || $4::jsonb WHERE id = $1`,
          [row.id, order.id, token, JSON.stringify({ order_id: order.id })]);

        const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
        if (!base) {
          console.error('[pay] PUBLIC_BASE_URL is not set — cannot host a checkout page');
          await send.text(mobile, 'Payment is not available right now. Please try again shortly.');
          return;
        }

        await setState(mobile, 'awaiting_payment', `order ${order.id}`);
        await send.text(mobile,
          `*${vehicle.reg_no}* — ₹${Math.round(paise / 100)} for ${plan.duration_days} days\n\n`
          + `Review and pay here:\n${base}/pay/${token}\n\n`
          + 'You will come straight back here, and I will confirm the moment the '
          + 'payment goes through.\n\n'
          + '_One vehicle per payment for now. To add another, just send me its '
          + 'number — I will send a separate link._');
        return;
      }

      case BTN.TRIAL_START: {
        const user = await store.upsertUser(mobile);
        const reg = await pendingReg(mobile);
        const price = Math.round(await settings.num('first_payment_paise', 4900) / 100);
        const r = await startTrial(user.id, reg);

        if (!r.ok && r.reason === 'trial_over') {
          await setState(mobile, 'owner_menu', 'trial already finished');
          await send.buttons(mobile,
            'Your free trial has already finished, so I cannot add another vehicle to it.\n\n'
            + `To watch *${reg}*, it is ₹${price} for 28 days. Checking any vehicle stays free.`,
            [{ id: BTN.SUBSCRIBE,     title: `Continue for ₹${price}` },
             { id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
          return;
        }
        if (!r.ok && r.reason === 'limit') {
          await setState(mobile, 'trial_active', 'trial vehicle limit reached');
          await send.text(mobile,
            `Your free trial already covers ${r.max} vehicles, which is the maximum.\n\n`
            + 'Checking any vehicle stays free — just send me a number.');
          return;
        }
        if (!r.ok) {
          await send.text(mobile,
            'Something went wrong starting the trial. Please reply *hi* and try again.');
          return;
        }

        await setState(mobile, 'trial_active', r.first ? 'trial started' : 'vehicle added to trial');
        await send.text(mobile, r.first
          ? `Done. ✅ I am now watching *${reg}* until *${until(r.endsAt, r.minutes)}*.\n\n`
            + 'I check every day and message you only if something needs your attention '
            + '— a new challan, or a document about to expire.\n\n'
            + (r.slotsLeft > 0
                ? `You can add ${r.slotsLeft} more vehicle${r.slotsLeft === 1 ? '' : 's'} — just send me the number.\n\n`
                : '')
            + 'Nothing to pay, and nothing will be charged automatically.'
          : `Done. ✅ *${reg}* added — I am now watching ${r.watching} vehicles, `
            + `all until *${until(r.endsAt, r.minutes)}*.\n\n`
            + (r.slotsLeft > 0
                ? `${r.slotsLeft} slot${r.slotsLeft === 1 ? '' : 's'} left on your trial.`
                : 'That is the maximum for a trial.'));
        await showEnrolled(mobile, user.id);
        return;
      }

      case BTN.PLATE_RETRY:
        await setState(mobile, 'owner_start', 'user chose to re-enter');
        await send.text(mobile, 'No problem. Please send the vehicle number again.');
        return;

      default:
        // An unknown id means a button from an older version of the flow.
        await welcome(mobile);
        return;
    }
  }

  /* ------------------------------------------------- documents on request */

  // "invoice" and "report" are typed, not tapped, because they are asked for
  // days later — long after any button has scrolled out of view.
  if (/^(invoice|bill|receipt)s?\s*$/i.test(intent.text)) {
    await sendInvoices(mobile);
    return;
  }
  if (/^(report|pdf|document)s?\s*$/i.test(intent.text)) {
    await sendReports(mobile);
    return;
  }

  // "hi" always returns to the start, from any state. Every reply in this file
  // tells people to do it, so it has to work everywhere — including when
  // someone is stuck halfway through a flow that no longer exists.
  if (/^(hi+|hello|hey|start|menu|namaste|namaskara|namaskar)\s*$/i.test(intent.text)) {
    await welcome(mobile);
    return;
  }

  // Typed text.
  switch (state) {
    case 'new':
    case 'main_menu':
      // Either they have not started, or they typed instead of tapping.
      // Re-offer rather than scold.
      await welcome(mobile);
      return;

    // Once someone has agreed to the terms, a vehicle number is always a
    // vehicle number — whether they are mid-flow, looking at a report, or
    // three days into a trial. Anything else makes them tap "hi" first, which
    // is a machine's requirement, not a person's.
    case 'owner_start':
    case 'owner_confirm':
    case 'owner_lookup':
    case 'owner_menu':
    case 'checkout_review':
    case 'awaiting_payment':
    case 'trial_active': {
      // If the policies have changed since they last agreed, the agreement on
      // file is to a different document. Ask once, then carry on.
      const current = await policyVersion();
      const agreed = await agreedVersion(mobile);
      if (agreed && agreed !== current) {
        await setState(mobile, 'owner_consent', `policy ${agreed} -> ${current}`);
        await send.buttons(mobile,
          'Our Terms have been updated since you last used GaadiPe.\n\n'
          + OWNER_TERMS,
          [{ id: BTN.AGREE_OWNER, title: 'Agree & continue' }]);
        return;
      }

      // A number sent at any of these points is a new number: someone
      // correcting themselves rather than tapping the button.
      const parsed = plate.parse(intent.text);
      if (!parsed.ok) {
        await send.text(mobile, parsed.error);
        return;
      }
      await askToConfirm(mobile, parsed);
      return;
    }

    case 'owner_consent':
      await send.text(mobile,
        'Please tap *Agree & continue* above to proceed. '
        + 'Reply *hi* if you would like to start again.');
      return;

    case 'partner_consent':
      await send.text(mobile,
        'Please tap *Agree & continue* above to join as a partner. '
        + 'Reply *hi* if you would like to start again.');
      return;

    default:
      // Past the menu, nothing is built yet. Say so honestly rather than going
      // quiet, which reads as broken.
      await send.text(mobile,
        'Sorry, I did not understand that yet — I am still learning. '
        + 'Reply *hi* to start again.');
      return;
  }
}

module.exports = { handle, welcome, recordConsent, BTN };
