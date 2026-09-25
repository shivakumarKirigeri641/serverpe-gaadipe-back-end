/**
 * src/whatsapp/flow.js
 * ---------------------------------------------------------------------------
 * The conversation. One function decides what GaadiPe says next.
 *
 * State lives in whatsapp_sessions.state, never in memory, because a bot that
 * forgets where someone was when the server restarts is worse than no bot.
 *
 * THE OWNER FLOW
 *   hi -> terms (Agree & continue) -> vehicle number -> basic details -> menu:
 *   Full report ₹19 · Feedback · Check other vehicle
 *
 * STATES SO FAR
 *   new              nobody has spoken yet — anything gets the terms
 *   main_menu        (older sessions) owner/partner menu was shown
 *   owner_consent    terms shown, waiting for agreement
 *   partner_consent  partner chose; partner policy shown, waiting for agreement
 *   owner_start      agreed — waiting for a vehicle number
 *   owner_confirm    a number was auto-corrected; waiting for confirm or re-enter
 *   owner_lookup     fetching from the gateway
 *   owner_menu       basic details sent; waiting for full report / feedback
 *   feedback         waiting for the person to type their feedback
 *   trial_active     one or more vehicles are being watched
 *   checkout_review  order summary shown; waiting for agree-and-pay
 *   verify_rc        waiting for the first characters of the chassis number
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
const verify = require('../vehicle/verify');
const reports = require('../pay/report');
const refer = require('../referrals/gaadipe');

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
  VERIFY_RC: 'verify_rc',
  BUY_REPORT: 'buy_report',
  DOWNLOAD_REPORT: 'download_report',
  FEEDBACK: 'feedback',
  REFER: 'refer',
  SUPPORT: 'support',
  MY_REPORTS: 'my_reports',
  INVOICE: 'invoice',
  MENU: 'menu',
};

const SITE = process.env.PUBLIC_SITE_URL || 'https://gaadipe.in';

/*
 * THE MENU, because nobody should have to remember a keyword.
 *
 * WhatsApp allows three reply buttons but ten list rows, so everything past
 * the first three lives here. Each row carries a button id the router already
 * understands, which is why adding one costs nothing anywhere else.
 */
/*
 * THE THREE DOORS. Shown after agreeing, and again after every action.
 *
 * Three is not a style choice — WhatsApp allows exactly three reply buttons,
 * and a reply button is one tap where a list is two. Anything rarer lives
 * behind Support or the longer menu.
 */
async function doors(mobile, body) {
  return send.buttons(mobile, body, [
    { id: BTN.CHECK_ANOTHER, title: 'Check vehicle' },
    { id: BTN.MY_REPORTS,    title: 'My vehicle reports' },
    { id: BTN.SUPPORT,       title: 'Support' },
  ]);
}

/**
 * Support: a link that opens the form already knowing who is writing.
 *
 * Six round trips of buttons to collect a query, a name and an email loses
 * people at every one. One screen collects it all, and the reply comes back
 * here. The link expires, and a fresh one is made each time — a link forwarded
 * to a friend should stop working.
 */
async function sendSupportLink(mobile) {
  const tickets = require('../support/tickets');
  const user = await store.upsertUser(mobile);
  const reg = await pendingReg(mobile);
  const { url, hours } = await tickets.linkFor({ userId: user.id, mobile, regNo: reg });

  await send.text(mobile,
    '💬 *Support*\n\n'
    + 'Tell us what is wrong and we will get back to you here, with a ticket number.\n\n'
    + `Open this to write to us (the link works for ${hours} hours):\n${url}`);

  await doors(mobile, 'Anything else?');
}

/*
 * THE VEHICLES THEY HAVE CHECKED, as a dropdown.
 *
 * WhatsApp allows ten list rows, so the ten most recent are offered and
 * anyone with more is told they can type the number — which is quicker than
 * paging through a list anyway. Each row says whether the full report is
 * already theirs, so the choice is informed before it is made.
 *
 * ONE VEHICLE IS NOT A CHOICE (user, 2026-09-25). Most owners have checked
 * exactly one plate — their own — and a dropdown with a single row is a tap
 * that asks nothing. So one vehicle goes straight to its report, basic or
 * paid, exactly as if they had picked it from the list. What each sends is
 * openVehicle()'s decision: the PDF if bought, the basic details if not.
 */
async function myVehicles(mobile, message) {
  const user = await store.upsertUser(mobile);
  const { rows } = await db.query(
    `SELECT v.reg_no, v.maker, v.model, uv.last_checked_at,
            EXISTS (SELECT 1 FROM vehicle_reports r
                     WHERE r.user_id = uv.user_id AND r.reg_no = v.reg_no
                       AND r.valid_until > now()) AS has_report,
            EXISTS (SELECT 1 FROM subscriptions sb
                     WHERE sb.user_id = uv.user_id AND sb.vehicle_id = uv.vehicle_id
                       AND sb.is_active AND sb.ends_on >= CURRENT_DATE) AS watched
       FROM user_vehicles uv
       JOIN vehicles v ON v.id = uv.vehicle_id
      WHERE uv.user_id = $1
      ORDER BY uv.last_checked_at DESC NULLS LAST
      LIMIT 11`, [user.id]);

  if (!rows.length) {
    await doors(mobile,
      'You have not checked any vehicle yet.\n\n'
      + 'Send me a vehicle number and I will look it up — the basics are free.');
    return;
  }

  if (rows.length === 1) {
    await openVehicle(mobile, rows[0].reg_no, message, 'only vehicle');
    return;
  }

  const more = rows.length > 10;
  const shown = rows.slice(0, 10);
  const out = await send.list(mobile, {
    body: more
      ? 'Which vehicle? These are your ten most recent — for any other, just send me its number.'
      : 'Which vehicle?',
    button: 'My vehicles',
    sectionTitle: 'Checked by you',
    rows: shown.map((r) => ({
      id: `veh:${r.reg_no}`,
      title: r.reg_no,
      description: [
        [r.maker, r.model].filter(Boolean).join(' ').slice(0, 30),
        r.has_report ? 'full report (PDF)' : 'basic details',
      ].filter(Boolean).join(' · '),
    })),
  });

  // A list needs an open 24-hour window. If it is shut, say it in plain text
  // rather than leaving them with nothing.
  if (!out.ok) {
    await send.text(mobile,
      'Your vehicles:\n\n'
      + shown.map((r) => `• *${r.reg_no}* — ${r.has_report ? 'full report (PDF)' : 'basic details'}`).join('\n')
      + '\n\nSend me the number of the one you want.');
  }
}

/**
 * Open one of their vehicles: remember it as the one in hand, then send what
 * they have for it. The same path whether it was picked from the list or was
 * the only one there was.
 *
 * A paid report still inside its download window is sent as the PDF they
 * bought — no lookup, no check spent. Anything else gets the basic details as
 * a message, never a PDF (user, 2026-09-25): the PDF is what ₹19 buys.
 */
async function openVehicle(mobile, reg, message, why) {
  const user = await store.upsertUser(mobile);
  const bought = await reports.validFor(user.id, reg);
  if (bought) {
    await sendValidReport(mobile, bought);
    return;
  }

  await db.query(
    `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now()
      WHERE mobile = $1`, [mobile, JSON.stringify({ pending_reg: reg })]);
  await setState(mobile, 'owner_lookup', why);
  await send.text(mobile, `Checking *${reg}* … ⏳`);
  await deliverReport(mobile, reg, message);
}

async function mainMenu(mobile, body = 'What would you like to do?') {
  const out = await send.list(mobile, {
    body,
    button: 'Choose',
    sectionTitle: 'GaadiPe',
    rows: [
      { id: BTN.CHECK_ANOTHER,   title: 'Check a vehicle',  description: 'Any Indian number — basics are free' },
      { id: BTN.DOWNLOAD_REPORT, title: 'My reports',       description: 'Send my report PDF again' },
      { id: BTN.INVOICE,         title: 'My GST invoice',   description: 'The tax invoice for a payment' },
      { id: BTN.REFER,           title: 'Refer & get free', description: 'A friend buys, your next is free' },
      { id: BTN.FEEDBACK,        title: 'Feedback',         description: 'Tell us what is wrong or missing' },
    ],
  });
  // A list needs an open 24-hour window; if it is shut, buttons would fail too,
  // but a plain sentence still arrives.
  if (!out.ok) await send.text(mobile, `${body}\n\nSend a vehicle number to begin.`);
  return out;
}
const baseUrl = () => (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

const INTRO =
  'Namaste! 🙏 This is *GaadiPe* — Government vehicle records on WhatsApp.\n\n'
  + 'Before buying a used vehicle, check its loan, blacklist and challan status. '
  + 'Own one? Get told before a document expires or a new challan appears.\n\n';

/**
 * One row per step of the owner funnel, all under one kind, so the whole funnel
 * is a single GROUP BY:
 *
 *   hi -> agreed -> number -> basic_shown -> buy_tapped -> link_sent -> (payment_paid)
 *
 * Never allowed to break the conversation it is measuring.
 */
async function funnel(mobile, step, detail = {}) {
  try {
    // The first steps happen before a users row exists, so mobile is what joins
    // the funnel together; user_id is filled in once there is one.
    const u = await db.one(`SELECT id FROM users WHERE mobile = $1`, [mobile]);
    await db.query(
      `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'funnel', $2)`,
      [u?.id || null, JSON.stringify({ step, mobile, ...detail })]);
  } catch (e) {
    console.error('[funnel] %s: %s', step, e.message);
  }
}

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
 * A PAID REPORT CAN BE DOWNLOADED AGAIN FOR report_valid_days. After that the
 * PDF they were sent is still theirs, but a fresh copy means today's records,
 * and today's records are what the price buys — so a lapsed report is answered
 * with the offer to check the vehicle again.
 *
 * Reports issued before the validity window existed have no valid_until and
 * keep following their subscription, as they always did.
 */
async function sendReports(mobile) {
  const user = await store.upsertUser(mobile);

  // A paid report that could not be issued when the payment landed (the
  // records service was down) is issued now — this is the "reply report"
  // the customer was promised.
  const missing = await db.query(
    `SELECT p.id FROM payments p
       JOIN plans pl ON pl.id = p.plan_id
      WHERE p.user_id = $1 AND p.status = 'paid' AND pl.kind = 'report'
        AND NOT EXISTS (SELECT 1 FROM vehicle_reports r WHERE r.payment_id = p.id)
      ORDER BY p.id DESC LIMIT 3`, [user.id]);
  if (missing.rows.length) {
    const { deliverPaidReport } = require('../routes/payments');
    let recovered = 0;
    for (const p of missing.rows) {
      const r = await deliverPaidReport(p.id, { withText: true });
      if (r.ok) recovered++;
      else if (r.reason === 'lookup_failed') {
        await send.buttons(mobile,
          'The Government records service is still slow, so your report is not ready yet. '
          + 'Please try again in a few minutes. Your payment is safe.',
          [{ id: BTN.DOWNLOAD_REPORT, title: 'Try again' },
           { id: BTN.MENU,            title: 'Menu' }]);
        return;
      }
    }
    if (recovered) return;
  }

  const { rows } = await db.query(
    `SELECT r.report_number, r.pdf_path, r.reg_no, r.created_at, r.valid_until,
            r.access_token, s.ends_on, s.is_active
       FROM vehicle_reports r
       LEFT JOIN subscriptions s ON s.id = r.subscription_id
      WHERE r.user_id = $1
      ORDER BY r.id DESC LIMIT 4`, [user.id]);

  if (!rows.length) {
    await send.text(mobile,
      'You do not have any reports yet.\n\n'
      + 'Send me a vehicle number — after the basic check you can get the full report.');
    return;
  }

  const now = new Date();
  const live = rows.filter(r => (r.valid_until
    ? new Date(r.valid_until) > now
    : r.is_active && r.ends_on && new Date(r.ends_on) >= now));

  for (const r of live) {
    if (r.valid_until) {
      await sendValidReport(mobile, r);
      continue;
    }
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

  if (!live.length) {
    const reg = rows[0].reg_no;
    await db.query(
      `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now()
        WHERE mobile = $1`, [mobile, JSON.stringify({ pending_reg: reg })]);
    await setState(mobile, 'owner_start', 'reports lapsed');
    await send.buttons(mobile,
      `Your report for *${reg}* can no longer be downloaded — its download period has ended.\n\n`
      + 'Send the vehicle number again to check today\'s records.',
      [{ id: BTN.CHECK_ANOTHER, title: 'Check a vehicle' }]);
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

  await db.query(
    `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now()
      WHERE mobile = $1`, [mobile, JSON.stringify({ pending_reg: regNo })]);

  // Someone who has already bought the report for this vehicle sees the full
  // detail again while it is valid; everyone else sees what the vehicle is and
  // how many things need attention — not which.
  const bought = await reports.validFor(user.id, regNo);
  const plan = bought ? null : await billing.reportPlan();
  await send.text(mobile, bought
    ? await report.buildFor(data, { detailed: true })
    : report.basic(data, plan ? { price: `₹${Math.round(plan.price_paise / 100)}` } : {}));
  await setState(mobile, 'owner_menu', 'basic details sent');
  await funnel(mobile, 'basic_shown', { reg_no: regNo, bought: Boolean(bought) });
  await reportMenu(mobile, regNo, data, bought);
}

/**
 * What the full report holds that the basic check did not show — stated as
 * what was FOUND, not as a feature list.
 *
 * "Loan / hypothecation: record found" is a reason to pay; "includes financer
 * details" is a brochure. Only things the paid PDF really contains are named
 * here, and nothing is revealed beyond the fact that a record exists.
 */
function lockedLines(data) {
  const rc = data.rc || {};
  const c = data.challans || {};
  const present = (v) => v && !/^(NA|N\/A|NONE|NULL|-|—)$/i.test(String(v).trim());

  const lines = [
    `• Loan / hypothecation — ${present(rc.financer) ? '*record found*' : 'checked'}`,
    `• Blacklist & NOC — ${present(rc.blacklist_status) || present(rc.noc_details) ? '*record found*' : 'checked'}`,
  ];
  if ((c.pending_count || 0) > 0) {
    lines.push(`• Challan numbers & offences — *${c.pending_count} pending*`);
  } else {
    lines.push('• Challan history & offences');
  }
  lines.push('• Insurer, policy & PUC references');
  return lines;
}

/**
 * What comes after the basic details.
 *
 * The offer is stated in full on the menu itself: what is locked, what the
 * price buys, for how long, and that nothing renews. A button that only said
 * "Full report" would leave the monitoring — half of what is sold — unseen.
 */
async function reportMenu(mobile, regNo, data, bought) {
  if (bought) {
    await send.buttons(mobile,
      `You already have the full report for *${regNo}*.\n\n`
      + `📄 Download it again any time until *${fmt(new Date(bought.valid_until))}*.`,
      [{ id: BTN.DOWNLOAD_REPORT, title: 'Download report' },
       { id: BTN.FEEDBACK,        title: 'Feedback' },
       { id: BTN.CHECK_ANOTHER,   title: 'Check other vehicle' }]);
    return;
  }

  const plan = await billing.reportPlan();
  if (!plan) {
    console.error('[wa] REPORT19 plan missing — run migrations');
    await send.buttons(mobile, 'What would you like to do next?',
      [{ id: BTN.FEEDBACK,      title: 'Feedback' },
       { id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
    return;
  }
  const price = `₹${Math.round(plan.price_paise / 100)}`;
  const validDays = await settings.num('report_valid_days', 7);

  await send.buttons(mobile,
    `🔒 *Full report for ${regNo}*\n\n`
    + lockedLines(data).join('\n')
    + `\n\n*${price}* — one-time\n`
    + `📄 PDF report on WhatsApp — download again for ${validDays} days\n`
    + `🔔 New challans watched ${plan.duration_days} days, and a warning before insurance, PUC, `
    + 'road tax, fitness or permit about to expire\n\n'
    + '_* Price includes GST. Owner details are never shown. Nothing renews automatically._',
    [{ id: BTN.BUY_REPORT,    title: `Full report ${price}*` },
     { id: BTN.FEEDBACK,      title: 'Feedback' },
     { id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
}

/**
 * Hi -> the terms, with one button.
 *
 * Every "hi" shows them: it is the one moment a person has plainly started
 * over, and agreeing is a single tap.
 */
async function start(mobile) {
  await funnel(mobile, 'hi');
  await send.buttons(mobile, INTRO + OWNER_TERMS,
    [{ id: BTN.AGREE_OWNER, title: 'Agree & continue' }],
    { footer: 'ServerPe App Solutions' });
  await setState(mobile, 'owner_consent', 'terms shown');
}

/** Send a still-valid report: the PDF, and a link that works until it lapses. */
async function sendValidReport(mobile, r) {
  const ends = fmt(new Date(r.valid_until));
  const link = baseUrl() && r.access_token ? `${baseUrl()}/report/${r.access_token}` : null;
  const caption = `📋 ${r.report_number} — ${r.reg_no}\nDownload again until ${ends}`
    + (link ? `\n${link}` : '');

  const sent = r.pdf_path
    ? await send.document(mobile, r.pdf_path, { filename: `${r.report_number}.pdf`, caption })
    : { ok: false };
  if (!sent.ok) {
    await send.text(mobile, `${caption}\n\n_The file could not be attached${link ? ' — use the link above' : ''}._`);
  }
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
/**

 * Their own referral link, as something to forward.

 *

 * Two messages on purpose: the first is the explanation, for them; the

 * second is the one they pass on, so the explanation does not travel with

 * it. Reached by tapping "Refer & get free" or by typing "refer".

 */

async function sendReferral(mobile) {

    const user = await store.upsertUser(mobile);

    const summary = await refer.summaryFor(user);

    if (!summary.enabled) {

      await send.text(mobile, 'Referrals are not running at the moment.');

      return;

    }

    const plan = await billing.reportPlan().catch(() => null);

    const price = Math.round((plan?.price_paise || 1900) / 100);

    await send.text(mobile,

      '🎁 *Refer a friend*\n\n'

      + `Anyone who has a vehicle. When they buy their first report at ₹${price}, `

      + 'your next full report is free.\n\n'

      + (summary.available

        ? `You have *${summary.available}* free report${summary.available === 1 ? '' : 's'} waiting — `

          + 'send me a vehicle number and I will use one.\n\n'

        : '')

      + 'Forward the message below 👇');

    await send.text(mobile,

      'Check any vehicle on GaadiPe — challans, insurance, PUC and road tax, '

      + `straight from the Government record.\n\n${summary.share_url}`);

}

async function handle(session, message, mobile) {
  const intent = intentOf(message);
  const state = session.state || 'new';

  /*
   * ARRIVED THROUGH A FRIEND'S LINK (user, 2026-09-23).
   *
   * "Hi GaadiPe (ref ABC123)" — the code travels in the very first message,
   * before there is a user row, a session state or anything to hang it on. So
   * it is read here, ahead of the state machine, and never inside a branch of
   * it: a referral that only worked from one state would be lost by anyone who
   * typed something else first.
   *
   * Attaching is allowed to fail quietly. Their own link, already a customer,
   * already referred — each is a real rule, and none of them is a reason to
   * refuse the person a conversation.
   */
  const referralCode = refer.codeFromText(intent.text);
  if (referralCode) {
    const user = await store.upsertUser(mobile);
    const out = await refer.attach(user, referralCode, { deviceId: null, ip: null })
      .catch(() => ({ ok: false }));
    console.log('[wa] %s arrived through %s -> %s', mobile, referralCode, out.ok ? 'attached' : out.reason);
    // Whatever the verdict, they have just walked in: start at the beginning.
    await start(mobile);
    return;
  }

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
      await openVehicle(mobile, intent.id.slice(4), message, 'chosen from list');
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
        await funnel(mobile, 'agreed');
        await setState(mobile, 'owner_start', 'consent given');
        await doors(mobile,
          'Thank you. ✅\n\n'
          + 'What would you like to do?\n\n'
          + '_To check a vehicle you can also just send its number, like *KA31N8147*._');
        return;

      case BTN.AGREE_PARTNER:
        await recordConsent(mobile, 'partner', ['partner-policy', 'privacy']);
        await setState(mobile, 'partner_start', 'consent given');
        await send.buttons(mobile,
          'Thank you. ✅ You have agreed to the partner terms.\n\n'
          + 'Your partner account is being set up.',
          [{ id: BTN.CHECK_ANOTHER, title: 'Check a vehicle' }]);
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

      case BTN.VERIFY_RC: {
        const user = await store.upsertUser(mobile);
        const reg = await pendingReg(mobile);
        const vehicle = reg
          ? await db.one('SELECT id, reg_no FROM vehicles WHERE reg_no = $1', [reg]) : null;
        if (!vehicle) {
          await send.text(mobile, 'Please send the vehicle number first.');
          return;
        }
        if (!await verify.challengeable(vehicle.id)) {
          await send.text(mobile,
            'This vehicle cannot be verified — the Government record does not '
            + 'include enough of the chassis number.');
          return;
        }
        const need = await settings.num('verify_prefix_length', 5);
        await db.query(
          'UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1',
          [mobile, JSON.stringify({ verify_reg: vehicle.reg_no })]);
        await setState(mobile, 'verify_rc', 'awaiting chassis prefix');
        await send.text(mobile,
          `To add a *RC verified* badge to *${vehicle.reg_no}*, send the first `
          + `*${need} characters* of the chassis number from your RC.\n\n`
          + 'It is printed on your registration certificate, and stamped on the vehicle.\n\n'
          + '_GaadiPe never displays chassis numbers — which is exactly why this works._');
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

      // "Check vehicle" means a number they have not given yet (user,
      // 2026-09-25). The vehicles they already have live behind "My vehicle
      // reports"; offering them here answered a question nobody asked.
      case BTN.CHECK_ANOTHER:
        await setState(mobile, 'owner_start', 'checking another');
        await send.text(mobile, 'Send me the vehicle number — like *KA31N8147*.');
        return;

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
            + `To watch *${reg}*, it is ₹${price}. Checking any vehicle stays free.`,
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
          await send.buttons(mobile,
            'Something went wrong starting the trial. Please try again.',
            [{ id: BTN.CHECK_ANOTHER, title: 'Try again' },
             { id: BTN.MENU,          title: 'Menu' }]);
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

      /**
       * Full report. The tap is the purchase consent — the menu above it named
       * the price, what it buys and that nothing renews — so this goes straight
       * to the payment page rather than through a second summary. The page
       * itself repeats the summary before any money moves.
       */
      case BTN.BUY_REPORT: {
        const user = await store.upsertUser(mobile);
        const reg = await pendingReg(mobile);
        const vehicle = reg
          ? await db.one(`SELECT id, reg_no FROM vehicles WHERE reg_no = $1`, [reg]) : null;
        if (!vehicle) {
          await setState(mobile, 'owner_start', 'no vehicle to report on');
          await send.text(mobile, 'Please send the vehicle number again.');
          return;
        }
        await funnel(mobile, 'buy_tapped', { reg_no: vehicle.reg_no });

        // Already bought and still valid: hand it over, never charge twice.
        const existing = await reports.validFor(user.id, vehicle.reg_no);
        if (existing) {
          await sendValidReport(mobile, existing);
          return;
        }

        // Every precondition is checked BEFORE an order exists, so a missing
        // setting never leaves an orphan order behind.
        const plan = await billing.reportPlan();
        if (!plan || !razorpay.configured() || !baseUrl()) {
          console.error('[pay] cannot sell a report: plan=%s razorpay=%s PUBLIC_BASE_URL=%s',
            Boolean(plan), razorpay.configured(), Boolean(baseUrl()));
          await send.text(mobile, 'Payment is not available right now. Please try again shortly.');
          return;
        }

        // A tap twice on the same button reuses the unpaid order rather than
        // opening a second one that could be paid as well.
        let row = await db.one(
          `SELECT * FROM payments
            WHERE user_id = $1 AND plan_id = $2 AND status = 'created'
              AND checkout_token IS NOT NULL
              AND (raw->>'vehicle_id')::bigint = $3
              AND created_at > now() - interval '1 hour'
            ORDER BY id DESC LIMIT 1`, [user.id, plan.id, vehicle.id]);

        if (!row) {
          await db.query(
            `INSERT INTO event_log (user_id, vehicle_id, kind, detail)
                  VALUES ($1, $2, 'purchase_consent', $3)`,
            [user.id, vehicle.id,
             JSON.stringify({ mobile, reg_no: vehicle.reg_no, amount_paise: plan.price_paise,
                              plan: plan.code, documents: ['terms', 'refund', 'privacy'],
                              at: new Date().toISOString() })]);

          const pending = await billing.createPending({
            userId: user.id, planId: plan.id, amountPaise: plan.price_paise, vehicleId: vehicle.id,
          });

          let order;
          try {
            order = await razorpay.createOrder({
              amountPaise: plan.price_paise,
              receipt: `gp-${pending.id}`,
              // reference_id is what the webhook matches on. Without it a
              // captured payment whose browser callback was lost is never
              // activated.
              notes: { reference_id: `gp-${pending.id}`, reg_no: vehicle.reg_no,
                       mobile, plan: plan.code },
            });
            if (!order?.id) throw new Error('no order id returned');
          } catch (e) {
            console.error('[pay] order creation failed:', e.message);
            await send.text(mobile,
              'Sorry, I could not start the payment just now. Please try again in a minute.');
            return;
          }

          const token = require('crypto').randomBytes(16).toString('hex');
          row = (await db.query(
            `UPDATE payments SET order_id = $2, checkout_token = $3,
                    raw = COALESCE(raw,'{}'::jsonb) || $4::jsonb
              WHERE id = $1 RETURNING *`,
            [pending.id, order.id, token, JSON.stringify({ order_id: order.id })])).rows[0];
        }

        await setState(mobile, 'awaiting_payment', `order ${row.order_id}`);
        await funnel(mobile, 'link_sent', { reg_no: vehicle.reg_no, payment_row: row.id });
        await send.text(mobile,
          `*${vehicle.reg_no}* — full report · ₹${Math.round(row.amount_paise / 100)}\n\n`
          + `Pay securely here (UPI, card, netbanking):\n${baseUrl()}/pay/${row.checkout_token}\n\n`
          + 'The report arrives in this chat the moment the payment goes through.');
        return;
      }

      case BTN.DOWNLOAD_REPORT: {
        const user = await store.upsertUser(mobile);
        const reg = await pendingReg(mobile);
        const r = reg ? await reports.validFor(user.id, reg) : null;
        if (r) {
          await sendValidReport(mobile, r);
          return;
        }
        await sendReports(mobile);
        return;
      }

      case BTN.MY_REPORTS:
        await myVehicles(mobile, message);
        return;

      case BTN.SUPPORT:
        await sendSupportLink(mobile);
        return;

      case BTN.REFER:
        await sendReferral(mobile);
        return;

      case BTN.INVOICE:
        await sendInvoices(mobile);
        return;

      case BTN.MENU:
        await mainMenu(mobile);
        return;

      case BTN.FEEDBACK:
        await setState(mobile, 'feedback', 'asked for feedback');
        await send.text(mobile,
          'Tell me what you think — what was useful, what was missing, or what went wrong. '
          + 'Just type it as one message. 🙏');
        return;

      case BTN.PLATE_RETRY:
        await setState(mobile, 'owner_start', 'user chose to re-enter');
        await send.text(mobile, 'No problem. Please send the vehicle number again.');
        return;

      default:
        // An unknown id means a button from an older version of the flow.
        await start(mobile);
        return;
    }
  }

  /* ------------------------------------------------- documents on request */

  // "invoice" and "report" are typed, not tapped, because they are asked for
  // days later — long after any button has scrolled out of view.
  /*
   * "refer" — their own link, as a message they can forward as it stands.
   * Sent as two messages on purpose: the explanation is for them, and the
   * second one is the thing they pass on, so it travels without the
   * explanation attached to it.
   */
  if (/^(refer|referral|invite|share)\s*$/i.test(intent.text)) {
    await sendReferral(mobile);
    return;
  }

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
    await start(mobile);
    return;
  }

  // Typed text.
  switch (state) {
    case 'new':
    case 'main_menu':
      // Either they have not started, or they typed instead of tapping.
      // Re-offer rather than scold.
      await start(mobile);
      return;

    // Whatever they type next is the feedback — including something that looks
    // like a vehicle number. "hi" above still gets them out.
    case 'feedback': {
      const user = await store.upsertUser(mobile);
      const reg = await pendingReg(mobile);
      await db.query(
        `INSERT INTO feedback (user_id, mobile, reg_no, body) VALUES ($1, $2, $3, $4)`,
        [user.id, mobile, reg, intent.text || `[${message.type}]`]);
      console.log('[wa] feedback from %s: %s', mobile, String(intent.text).slice(0, 80));
      await setState(mobile, 'owner_start', 'feedback received');
      await send.buttons(mobile,
        'Thank you — every message is read. 🙏\n\nSend another vehicle number any time.',
        [{ id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
      return;
    }

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
      await funnel(mobile, 'number', { reg_no: parsed.regNo, repaired: Boolean(parsed.repaired) });

      // Read back only what we changed. A number typed correctly goes straight
      // to the lookup; one we corrected (O for 0, a padded serial) could be a
      // different vehicle, and that is worth one tap before anyone pays.
      if (parsed.repaired) {
        await askToConfirm(mobile, parsed);
        return;
      }
      await setState(mobile, 'owner_lookup', 'number received');
      await send.text(mobile, `Checking *${parsed.regNo}* … ⏳`);
      await deliverReport(mobile, parsed.regNo, message);
      return;
    }

    case 'verify_rc': {
      const user = await store.upsertUser(mobile);
      const ctx = await sessionContext(mobile);
      const vehicle = ctx.verify_reg
        ? await db.one('SELECT id, reg_no FROM vehicles WHERE reg_no = $1', [ctx.verify_reg]) : null;
      if (!vehicle) {
        await setState(mobile, 'owner_start', 'verification lost');
        await send.text(mobile, 'Please send the vehicle number again.');
        return;
      }

      const r = await verify.attempt(user.id, vehicle.id, intent.text);
      if (r.ok) {
        await setState(mobile, 'owner_menu', 'rc verified');
        const limit = await settings.num('free_checks_per_day_verified', 25);
        await send.buttons(mobile,
          `✅ *${vehicle.reg_no}* is now *RC verified*.\n\n`
          + 'The badge appears on your reports, and you now get '
          + `${limit} free checks a day.`,
          [{ id: BTN.ENROLLED,      title: 'Enrolled vehicles' },
           { id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
        return;
      }
      if (r.reason === 'locked' || r.reason === 'locked_now') {
        await setState(mobile, 'owner_menu', 'verification locked');
        await send.text(mobile,
          'That did not match, and there have been too many attempts. '
          + 'Please try again tomorrow.\n\n'
          + 'Everything else keeps working as normal.');
        return;
      }
      await send.buttons(mobile,
        `That does not match our records. ${r.attemptsLeft} attempt`
        + `${r.attemptsLeft === 1 ? '' : 's'} left.\n\n`
        + 'Send the first characters of the chassis number exactly as printed on '
        + 'the RC.',
        [{ id: BTN.CHECK_ANOTHER, title: 'Do this later' }]);
      return;
    }

    case 'owner_consent':
      await send.buttons(mobile,
        'Please tap *Agree & continue* above to proceed. '
        + 'Tap below to start again.',
        [{ id: BTN.CHECK_ANOTHER, title: 'Start again' }]);
      return;

    case 'partner_consent':
      await send.buttons(mobile,
        'Please tap *Agree & continue* above to join as a partner. '
        + 'Tap below to start again.',
        [{ id: BTN.CHECK_ANOTHER, title: 'Start again' }]);
      return;

    default:
      // Past the menu, nothing is built yet. Say so honestly rather than going
      // quiet, which reads as broken.
      await send.buttons(mobile,
        'Sorry, I did not understand that yet — I am still learning. '
        + 'Tap below to start again.',
        [{ id: BTN.CHECK_ANOTHER, title: 'Start again' }]);
      return;
  }
}

module.exports = { handle, welcome, recordConsent, BTN };
