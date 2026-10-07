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
 *   owner_verify_reg      owner verification: which vehicle (src/owners/verify.js)
 *   owner_verify_chassis  …the chassis number from the RC
 *   owner_verify_second   …the policy or engine number, then the verdict
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
const track = require('../events/track');
const plate = require('../util/plate');
const gateway = require('../vehicle/gateway');
const store = require('../vehicle/store');
const report = require('./report');
const settings = require('../util/settings');
const quota = require('../util/quota');
const razorpay = require('../pay/razorpay');
const billing = require('../pay/billing');
const owners = require('../owners/verify');
const ownerPhoto = require('../owners/photo');
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
  FLEET: 'fleet',
  OWNER_VERIFY: 'owner_verify',
  OWNER_HIDE: 'owner_hide',
  OWNER_SHOW: 'owner_show',
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
/* "More" (user, 2026-09-29): the longer list — Support, Fleet, invoices,
   feedback — was only ever reached from two rare error messages. Support is
   its first row. */
async function doors(mobile, body) {
  return send.buttons(mobile, body, [
    { id: BTN.CHECK_ANOTHER, title: 'Check vehicle' },
    { id: BTN.MY_REPORTS,    title: 'My vehicle reports' },
    { id: BTN.MENU,          title: 'More' },
  ]);
}

/* GaadiPe for fleets (user, 2026-09-29): by email only. The owner writes to
   support@gaadipe.in with the vehicle list; the admin quotes, and once paid
   and approved the fleet gets one Excel email every evening. */
async function sendFleetInfo(mobile) {
  await send.text(mobile,
    '🚛 *GaadiPe for fleets* — 5 or more vehicles\n\n'
    + 'Every evening, one email with an *Excel report of your whole fleet*: a row per vehicle, '
    + 'with insurance, PUC (emission test), road tax, fitness, permit and pending challans — '
    + 'coloured green, amber or red so you see at once what needs action.\n\n'
    + '*To start, email support@gaadipe.in with:*\n'
    + '1. Company name and your name\n'
    + '2. Email for the daily report\n'
    + '3. GSTIN (for a GST invoice, optional)\n'
    + '4. The list of vehicle numbers (5 or more)\n'
    + '5. The line: "We own or operate these vehicles"\n\n'
    + 'Subject: *Fleet enquiry*\n'
    + 'We reply quickly with your quotation — ₹19 per vehicle for 28 days.');
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
      { id: BTN.SUPPORT,         title: 'Support',          description: 'Ask us anything — we reply with a ticket number' },
      { id: BTN.FLEET,           title: 'Fleet (5+ vehicles)', description: 'Daily Excel report of all your vehicles, by email' },
      { id: BTN.CHECK_ANOTHER,   title: 'Check a vehicle',  description: 'Any Indian number — basics are free' },
      { id: BTN.DOWNLOAD_REPORT, title: 'My reports',       description: 'Send my report PDF again' },
      { id: BTN.INVOICE,         title: 'My GST invoice',   description: 'The tax invoice for a payment' },
      { id: BTN.FEEDBACK,        title: 'Feedback',         description: 'Tell us what is wrong or missing' },
      ...(await owners.enabled()
        ? [{ id: BTN.OWNER_VERIFY, title: 'I own a vehicle', description: 'Verify it with your RC — badge, and hide it from others' }] : []),
    ],
  });
  // A list needs an open 24-hour window; if it is shut, buttons would fail too,
  // but a plain sentence still arrives.
  if (!out.ok) await send.text(mobile, `${body}\n\nSend a vehicle number to begin.`);
  return out;
}
const baseUrl = () => (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

/* SHORTER (user, 2026-09-28): 4 in 10 people left at the old 12-line terms
   screen. The same three documents, the same STOP promise and the same
   recorded agreement — only fewer words before the button. The documents
   themselves and the policy version are unchanged, so nobody is re-asked. */
const INTRO =
  'Namaste! 🙏 *GaadiPe* shows any vehicle\'s insurance, PUC, tax, challan and loan status '
  + 'from Government records, right here on WhatsApp.\n\n';

/**
 * One row per step of the owner funnel, all under one kind, so the whole funnel
 * is a single GROUP BY:
 *
 *   hi -> agreed -> number -> basic_shown -> buy_tapped -> link_sent -> (payment_paid)
 *
 * Never allowed to break the conversation it is measuring.
 */
/* The bot's funnel steps, as the command center names them (migration 067). */
const STEP_EVENT = {
  hi: 'whatsapp_greeting',
  agreed: 'terms_accepted',
  number: 'whatsapp_vehicle_received',
  basic_shown: 'vehicle_search_success',
  lookup_failed: 'vehicle_search_failed',
  buy_tapped: 'report_preview_viewed',
  link_sent: 'payment_started',
  opt_out: 'whatsapp_opt_out',
  opt_in: 'whatsapp_opt_in',
};

async function funnel(mobile, step, detail = {}) {
  try {
    // The first steps happen before a users row exists, so mobile is what joins
    // the funnel together; user_id is filled in once there is one.
    const u = await db.one(`SELECT id FROM users WHERE mobile = $1`, [mobile]);
    const row = await db.one(
      `INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'funnel', $2) RETURNING id`,
      [u?.id || null, JSON.stringify({ step, mobile, ...detail })]);
    // …and into the command center's stream, under its own name for the step
    // (user, 2026-09-25). Keyed by this row, like migration 067's backfill.
    require('../events/track').fire({
      key: `funnel:${row.id}`, name: STEP_EVENT[step] || `whatsapp_${step}`, channel: 'whatsapp',
      userId: u?.id || null, mobile, regNo: detail.reg_no || null,
      paymentId: detail.payment_row || null,
      status: step === 'lookup_failed' ? 'failed' : 'ok',
      errorCode: step === 'lookup_failed' ? detail.reason || null : null,
      meta: { step, ...detail },
    });
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
  // "Reply STOP anytime" is no longer repeated here (user, 2026-10-05): the
  // Terms they agree to already say it (migration 062), and the line was
  // prompting people to reply STOP straight away.
  `Please agree to our Terms (${SITE}/terms), Privacy (${SITE}/privacy) and Refund (${SITE}/refund) policies to continue.`
  // One account, any channel (Terms 4.1, 2026-10-07).
  + ' You also agree to receive messages about your account, checks and reports on WhatsApp, SMS or email — the same account works on gaadipe.in.';

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
/* THE FREE TRIAL IS OFF (user, 2026-09-27): monitoring is strictly ₹19 per
   vehicle, so no vehicle is watched for free. trial_enabled turns it back on. */
const trialOn = async () => settings.bool('trial_enabled', false);

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
  if (!await trialOn()) return { ok: false, reason: 'disabled' };
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
    `SELECT r.id, r.report_number, r.pdf_path, r.reg_no, r.created_at, r.valid_until,
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
  if (!await trialOn()) {
    return `You have used your ${q.limit} free checks for today — they reset tomorrow.\n\n`
      + 'Want everything on a vehicle now? Tap *Full report* on any vehicle you have checked.';
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
/* ───────────── OWNER VERIFICATION (user, 2026-10-01, src/owners/verify.js) ───────────── */

const istTime = (at) => new Date(at).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});

/** "Which vehicle is yours?" — with a one-tap answer for the vehicle they last checked. */
async function askOwnedVehicle(mobile, lead = null) {
  if (!await owners.enabled()) {
    await doors(mobile, 'Owner verification is not open yet. You can still check any vehicle.');
    return;
  }
  if (await ownerPhoto.usePhotos()) { await askOwnedVehiclePhoto(mobile, lead); return; }
  const mine = await owners.mine(mobile);
  const last = await pendingReg(mobile);
  await setState(mobile, 'owner_verify_reg', 'asked which vehicle');
  const body = (lead ? `${lead}\n\n` : '')
    + '🔐 *Verify you own a vehicle*\n\n'
    + 'Two quick steps with your RC (registration certificate). Once verified you get the *Owner verified* badge, '
    + 'and you can *hide the vehicle from other people\'s checks*.\n\n'
    + (mine.length ? `Already verified: ${mine.map((m) => `*${m.reg_no}*${m.hidden_at ? ' (hidden)' : ''}`).join(', ')} — send one to hide or show it.\n\n` : '')
    + 'Send the *vehicle number*, like *KA01XX1234*.';
  if (last && !mine.some((m) => m.reg_no === last)) {
    await send.buttons(mobile, body, [{ id: `ownv:${last}`, title: `It is ${last}`.slice(0, 20) }]);
  } else {
    await send.text(mobile, body);
  }
}

/**
 * The invitation, RC-photo version (user, 2026-10-04): what they get, how
 * little it takes, and what happens to the photo — before anything is asked.
 * A customer may own several vehicles: each is verified on its own.
 */
async function askOwnedVehiclePhoto(mobile, lead = null) {
  const user = await db.one(`SELECT id FROM users WHERE mobile = $1`, [mobile]).catch(() => null);
  const { verified, review } = await ownerPhoto.mine(mobile);
  const offer = await ownerPhoto.offerLine({ userId: user?.id, mobile });
  const last = await pendingReg(mobile);
  await setState(mobile, 'owner_verify_reg', 'asked which vehicle (photo)');
  const body = (lead ? `${lead}\n\n` : '')
    + '🔐 *Prove you own your vehicle — and get rewarded*\n\n'
    + (offer ? `${offer}\n` : '')
    + '🏅 *Owner verified* seal on your vehicle report\n'
    + '🛡️ *Hide your vehicle* from other people\'s checks\n'
    + '🤝 *Coming soon:* people can reach you about your vehicle — without ever seeing your number\n\n'
    + '⏱️ *Takes 1 minute:* send the vehicle number, then a photo of its RC.\n'
    + '🔒 The photo is seen only by GaadiPe and *deleted as soon as it is checked*.\n\n'
    + (verified.length ? `✅ Verified: ${verified.map((m) => `*${m.reg_no}*${m.hidden_at ? ' (hidden)' : ''}`).join(', ')}\n` : '')
    + (review.length ? `⏳ Being checked: ${review.map((m) => `*${m.reg_no}*`).join(', ')}\n` : '')
    + (verified.length || review.length ? 'Own another vehicle? Verify it too.\n\n' : '')
    + 'Send the *vehicle number*, like *KA01XX1234*.';
  const known = new Set([...verified, ...review].map((m) => m.reg_no));
  if (last && !known.has(last)) {
    await send.buttons(mobile, body, [{ id: `ownv:${last}`, title: `It is ${last}`.slice(0, 20) }]);
  } else {
    await send.text(mobile, body);
  }
}

/** The vehicle is chosen: ask for the RC photo, with the promise around it. */
async function startPhotoClaim(mobile, regNo, message) {
  const user = await store.upsertUser(mobile, { name: message?.profile?.name, waId: message?.from });
  const r = await ownerPhoto.begin({ userId: user.id, mobile, regNo });
  await db.query(
    `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1`,
    [mobile, JSON.stringify({ ov_reg: regNo, ov_claim: r.claimId || null })]);
  if (!r.ok) {
    await setState(mobile, 'owner_menu', `owner verification: ${r.reason}`);
    if (r.reason === 'already') {
      const hidden = (await owners.mine(mobile)).find((m) => m.reg_no === regNo)?.hidden_at;
      await send.buttons(mobile,
        `✅ *${regNo}* is already *Owner verified* on this number, and it is ${hidden ? '*hidden* from' : '*visible* in'} other people's checks.`,
        [{ id: hidden ? BTN.OWNER_SHOW : BTN.OWNER_HIDE, title: hidden ? 'Show it again' : 'Hide from others' },
          { id: BTN.CHECK_ANOTHER, title: 'Check vehicle' }]);
      return;
    }
    await doors(mobile, {
      off: 'Owner verification is not open yet. You can still check any vehicle.',
      in_review: `⏳ Your RC photo for *${regNo}* is already being checked. You will get a message here as soon as it is done.`,
      too_many: 'You have sent several RC photos today. Please try again tomorrow. 🙏',
    }[r.reason] || 'Sorry, that could not be started. Please try again later.');
    return;
  }
  await setState(mobile, 'owner_verify_photo', 'asked for the RC photo');
  await funnel(mobile, 'owner_verify_started', { reg_no: regNo, method: 'rc_photo' });
  const reward = await ownerPhoto.rewardFor({ userId: user.id, mobile, regNo });
  const days = await settings.num('owner_verify_extend_days', 28);
  await send.text(mobile,
    `🔐 *Verify ${regNo}*\n\n`
    + '📸 Send a clear photo of your *RC* here in this chat — the card, the paper RC, or the *DigiLocker / mParivahan RC* (PDF is fine).\n\n'
    + '*We only need to see:*\n'
    + '✔️ Vehicle number\n✔️ Owner name\n✔️ Chassis number\n'
    + '_You may cover your address, photo and date of birth._\n\n'
    + '🛡️ *Our promise to you*\n'
    + '• Only GaadiPe looks at it — it is *never shared or shown* to anyone\n'
    + '• It is kept *locked (encrypted)* while we check it\n'
    + '• It is *deleted as soon as we decide* — approved or not. We keep only the result: ✅ or ❌\n'
    + '• Nothing from your RC is saved\n\n'
    + '⏱️ We check it within a few hours and message you right here.'
    + ({ report: '\n\n🎁 Once verified, your *full report comes FREE*.',
      extend: `\n\n🎁 Once verified, your running report gets *+${days} days, free*.` }[reward] || ''));
}

/** The RC photo arrived. */
async function receiveRcPhoto(mobile, message) {
  const r = await ownerPhoto.receive(mobile, message);
  if (r.ok) {
    await setState(mobile, 'owner_menu', 'RC photo received');
    await funnel(mobile, 'owner_photo_sent', { reg_no: r.regNo });
    await send.text(mobile,
      '📸 *Got it — thank you!* 🙏\n\n'
      + `Your RC for *${r.regNo}* is now *being checked*. You will get a message here as soon as it is done — usually within a few hours.\n\n`
      + '🔒 It is kept locked, seen only by GaadiPe, and *deleted as soon as it is checked*.\n\n'
      + 'Meanwhile, you can send any vehicle number to check it.');
    return;
  }
  await send.text(mobile, {
    not_a_photo: 'Please send a *photo* (or the RC *PDF*) of your RC — other files cannot be checked.',
    too_big: 'That file is too large. Please send a photo of the RC (under 10 MB).',
    failed: 'Sorry, that photo did not come through. Please send it again. 🙏',
  }[r.reason] || 'Please send a photo of your RC.');
}

async function startOwnerClaim(mobile, regNo, message) {
  if (!await owners.enabled()) { await askOwnedVehicle(mobile); return; }
  if (await ownerPhoto.usePhotos()) { await startPhotoClaim(mobile, regNo, message); return; }
  const user = await store.upsertUser(mobile, { name: message?.profile?.name, waId: message?.from });
  let r = await owners.begin({ userId: user.id, mobile, regNo });
  if (!r.ok && r.reason === 'no_record') {
    // Never checked here before: the RC is what the answers are compared with.
    const data = await gateway.full(regNo, await require('../vehicle/rcBackup').freeOpts()).catch(() => null);
    if (data?.success === true) {
      await store.record(user.id, data).catch(() => {});
      r = await owners.begin({ userId: user.id, mobile, regNo });
    } else if (data?.error === 'vehicle_not_found') {
      r = { ok: false, reason: 'not_found' };
    } else {
      r = { ok: false, reason: 'busy' };
    }
  }
  await db.query(
    `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1`,
    [mobile, JSON.stringify({ ov_reg: regNo, ov_claim: r.claimId || null })]);

  if (r.ok) {
    await setState(mobile, 'owner_verify_chassis', 'claim started');
    await funnel(mobile, 'owner_verify_started', { reg_no: regNo });
    await send.text(mobile,
      `🔐 Verifying *${regNo}*\n\n`
      + '*Step 1 of 2:* type the full *chassis number* (Chassis No.) from your RC — usually 17 letters and numbers.\n\n'
      + '_What you type is only compared with the Government record — it is never stored or shown._');
    return;
  }
  await setState(mobile, 'owner_menu', `owner verification: ${r.reason}`);
  if (r.reason === 'already') {
    const hidden = (await owners.mine(mobile)).find((m) => m.reg_no === regNo)?.hidden_at;
    await send.buttons(mobile,
      `✅ *${regNo}* is already *Owner verified* on this number, and it is ${hidden ? '*hidden* from' : '*visible* in'} other people's checks.`,
      [{ id: hidden ? BTN.OWNER_SHOW : BTN.OWNER_HIDE, title: hidden ? 'Show it again' : 'Hide from others' },
        { id: BTN.CHECK_ANOTHER, title: 'Check vehicle' }]);
    return;
  }
  await doors(mobile, {
    off: 'Owner verification is not open yet. You can still check any vehicle.',
    not_found: `I could not find a Government record for *${regNo}*. Please check the number.`,
    busy: 'The Government vehicle records service is not responding right now. Please try again in a little while.',
    not_checkable: `The Government record for *${regNo}* does not hold enough of the chassis and policy details to verify it here.\n\n`
      + 'Email a photo of your RC to support@gaadipe.in with the subject *Owner verification* and we will verify it by hand.',
    locked: `Too many tries for *${regNo}*. You can try again after *${istTime(r.lockedUntil)}*.`,
    vehicle_busy: `Verification for *${regNo}* is paused for today. Please try again tomorrow, or email a photo of your RC to support@gaadipe.in.`,
    too_many: 'Verification is paused on this number for today. Please try again tomorrow.',
  }[r.reason] || 'Sorry, that could not be started. Please try again later.');
}

async function deliverReport(mobile, regNo, message) {
  const user = await store.upsertUser(mobile, {
    name: message?.profile?.name, waId: message?.from,
  });

  /*
   * NOT SHOWN: a vehicle the admin blocked (an owner's objection, DPDP), or
   * one its verified owner chose to hide (src/owners/verify.js). Asked before
   * the quota and the lookup, so nothing is spent.
   */
  if (await require('../admin/blocks').isBlocked('vehicle', regNo) || await owners.hiddenFrom(mobile, regNo)) {
    await setState(mobile, 'owner_start', 'vehicle private');
    await funnel(mobile, 'vehicle_private', { reg_no: regNo });
    await send.text(mobile, `🔒 The owner of *${regNo}* keeps its details private, so GaadiPe cannot show them.\n\n`
      + 'If this vehicle is yours, write to support@gaadipe.in. You can send another vehicle number any time.');
    return;
  }

  // Asked before the call, not after: the point is to not spend the lookup.
  const q = await quota.check(user.id, regNo);
  if (!q.allowed) {
    await setState(mobile, 'owner_menu', `quota ${q.reason}`);
    await send.buttons(mobile, await quotaMessage(q),
      q.tier === 'stranger' && await trialOn()
        ? [{ id: BTN.TRIAL_START, title: 'Start free trial' }]
        : [{ id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
    return;
  }
  if (!q.repeat && q.limit && q.used + 1 >= q.limit) {
    console.warn('[quota] %s at %d/%d (%s)', mobile, q.used + 1, q.limit, q.tier);
  }

  // The paid RC backup only for a vehicle they have paid for (rc_backup_paid_only):
  // a free check asks ULIP alone (vehicle/rcBackup.js freeOpts).
  const rcBackup = require('../vehicle/rcBackup');
  const ownsReport = await rcBackup.paidOnly() ? await reports.validFor(user.id, regNo).catch(() => null) : null;
  let data;
  try {
    data = await gateway.full(regNo, ownsReport ? {} : await rcBackup.freeOpts());
  } catch (e) {
    console.error('[wa] lookup failed for %s: %s', regNo, e.message);
    data = null;
  }

  await quota.record(user.id, regNo,
    { repeat: q.repeat, found: data?.success === true });

  // A "success" with no make, model or class is not a record (user, 2026-10-01):
  // it showed customers a blank free check. Treated as the service being busy.
  if (data && data.success === true && !(data.rc && (data.rc.maker || data.rc.model || data.rc.vehicle_class))) {
    console.error('[wa] lookup for %s came back with an empty record (source %s)', regNo, data.source);
    data = { success: false, error: 'empty_record' };
  }
  if (!data || data.success !== true) {
    const notFound = data?.error === 'vehicle_not_found';
    // Recorded like a successful check, so the admin hears about it too
    // (jobs/notify.js) — a lookup that fails is a customer who got nothing.
    await funnel(mobile, 'lookup_failed', { reg_no: regNo, reason: notFound ? 'not_found' : 'service_error' });
    await setState(mobile, 'owner_start', notFound ? 'vehicle not found' : 'lookup failed');
    if (notFound) {
      await send.text(mobile, `I could not find any Government record for *${regNo}*.\n\n`
        + 'Please check the number and send it again. Very new vehicles can take '
        + 'a few weeks to appear.');
      return;
    }
    /*
     * THE WAITING LIST (user, 2026-10-01): when the Government records service
     * is down, the number is kept and the check is sent here automatically once
     * it is back (jobs/waitlist.js) — nobody has to keep trying.
     */
    const listed = await settings.bool('lookup_waitlist_enabled', true)
      && await db.query(
        `INSERT INTO lookup_waitlist (mobile, reg_no, user_id) VALUES ($1, $2, $3)
         ON CONFLICT (mobile, reg_no) WHERE status = 'waiting' DO NOTHING`, [mobile, regNo, user.id])
        .then(() => true).catch((e) => { console.error('[wa] waitlist:', e.message); return false; });
    // Both ULIP and the paid backup failed (user, 2026-10-02): the vehicle
    // records server is down. Kept on the waiting list; a short line covers the
    // mistyped number, which looks the same from here.
    const downText = listed
      ? `⚠️ The Government vehicle records server is down right now, and the concerned authority is working on it. 🙏\n\n`
        + `I have saved *${regNo}* and will send its details *here, automatically*, as soon as it is back — no need to send it again.\n\n`
        + '_If the number was typed wrongly, just send the correct one._'
      : `⚠️ The Government vehicle records server is down right now, and the concerned authority is working on it. 🙏\n\n`
        + 'Please send the number again in a little while.';
    /*
     * CAN'T WAIT? BUY NOW (user, 2026-10-05). With the backup kept for paying
     * customers (rc_backup_paid_only), the free check waits for ULIP — but the
     * full report can be bought at once, and its lookup uses the backup. Only
     * while the backup is switched on and payments are open.
     */
    const plan = rcBackup && !ownsReport && await rcBackup.paidOnly() && await rcBackup.enabled().catch(() => false)
      && await require('../util/flags').on('payments') ? await billing.reportPlan().catch(() => null) : null;
    if (plan) {
      await db.query(`INSERT INTO vehicles (reg_no) VALUES ($1) ON CONFLICT (reg_no) DO NOTHING`, [regNo]);
      await db.query(
        `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1`,
        [mobile, JSON.stringify({ pending_reg: regNo })]);
      await funnel(mobile, 'buy_now_offered', { reg_no: regNo });
      await send.buttons(mobile, `${downText}\n\n`
        + `⚡ *Need it right now?* Get the *full report* for *${regNo}* immediately for *₹${Math.round(plan.price_paise / 100)}* — `
        + 'we fetch it from our backup source, with insurance, PUC, tax, fitness and challans.',
      [{ id: BTN.BUY_REPORT, title: `Full report ₹${Math.round(plan.price_paise / 100)}` }]);
      return;
    }
    await send.text(mobile, downText);
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
  // The verified owner's badge (src/owners/verify.js), on their own vehicle.
  const badge = await owners.isOwner(mobile, regNo) ? '✅ *Owner verified* — your vehicle\n\n' : '';
  // Its verified owner is told of this check (owners/checkAlerts.js) — and so is the checker.
  const watched = await require('../owners/checkAlerts').checkerNotice(regNo, mobile).catch(() => null);
  await send.text(mobile, badge + (watched ? `${watched}\n\n` : '') + (bought
    ? await report.buildFor(data, { detailed: true })
    : report.basic(data, {
      ...(plan ? { price: `₹${Math.round(plan.price_paise / 100)}` } : {}),
      // WhatsApp's own free level (user, 2026-09-28): 'labels' names what needs
      // attention — PUC expired, 2 pending challans — never dates or amounts.
      // The website keeps free_view_detail; the two are set apart on purpose.
      // Back to 'count' (user, 2026-09-30, migration 088): naming them gave the
      // answer away and people stopped paying.
      detail: String(await settings.get('whatsapp_free_view_detail', 'count')).toLowerCase(),
    })));
  await setState(mobile, 'owner_menu', 'basic details sent');
  await funnel(mobile, 'basic_shown', { reg_no: regNo, bought: Boolean(bought) });
  require('../owners/checkAlerts').noteCheck({ regNo, checker: mobile, channel: 'whatsapp' });
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

  const lines = [];
  // The count itself is in the report, not here (user, 2026-09-25). Only
  // offered when the record has it — the PDF prints "—" otherwise, and a
  // promise the report cannot keep is worse than no line.
  if (Number(rc.owner_serial) > 0) lines.push('• Number of owners — *on record*');
  lines.push(
    `• Loan / hypothecation — ${present(rc.financer) ? '*record found*' : 'checked'}`,
    `• Blacklist & NOC — ${present(rc.blacklist_status) || present(rc.noc_details) ? '*record found*' : 'checked'}`,
  );
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
  // A discount shows as the old price struck through (2026-10-03).
  const was = plan.discount_paise ? `~₹${Math.round(plan.list_price_paise / 100)}~ ` : '';
  const off = plan.discount_paise ? ` (₹${Math.round(plan.discount_paise / 100)} off)` : '';
  const validDays = await settings.num('report_valid_days', 7);

  // Free reports the admin gave this customer (admin/gifts.js): offered first.
  const user = await store.upsertUser(mobile).catch(() => null);
  // The automatic gift round, if on, reaches a paying customer here (admin/gifts.js).
  const fresh = user ? await require('../admin/gifts').ensureAuto(user.id).catch(() => 0) : 0;
  const giftsLeft = user ? (await require('../admin/gifts').available(user.id).catch(() => [])).length : 0;
  if (giftsLeft) {
    await send.buttons(mobile,
      `🔒 *Full report for ${regNo}*\n\n`
      + lockedLines(data).join('\n')
      + `\n\n${fresh ? '🎉 *A thank-you from GaadiPe for being a paying customer!*\n' : ''}🎁 You have *${giftsLeft} free full report${giftsLeft === 1 ? '' : 's'}* from GaadiPe — tap below to use one for ${regNo}. Nothing to pay.\n`
      + `📄 PDF report on WhatsApp — download again for ${validDays} days\n`
      + `🔔 New challans watched ${plan.duration_days} days, with expiry warnings`,
      [{ id: BTN.BUY_REPORT,    title: `🎁 Free report (${giftsLeft})` },
       { id: BTN.FEEDBACK,      title: 'Feedback' },
       { id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
    return;
  }

  await send.buttons(mobile,
    `🔒 *Full report for ${regNo}*\n\n`
    + lockedLines(data).join('\n')
    + `\n\n${was}*${price}* — one-time${off}\n`
    + `📄 PDF report on WhatsApp — download again for ${validDays} days\n`
    + `🔔 New challans watched ${plan.duration_days} days, and a warning before insurance, PUC, `
    + 'road tax, fitness or permit about to expire\n\n'
    // What the other way costs (user, 2026-09-30) — the same line as the website.
    + `🚫 RTO queue · 🚫 Fuel · 🚫 Follow-ups — *just ${price}* ✨\n\n`
    + '_* Price includes GST. Personal details are masked. Nothing renews automatically._',
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
  // The price before the first tap (user, 2026-09-30): someone who tapped
  // Full report expecting it free called it "worst". Read from the plan.
  const plan = await billing.reportPlan().catch(() => null);
  const price = plan
    ? `✅ Basic check — *free* · 📋 Full report — ${plan.discount_paise ? `~₹${Math.round(plan.list_price_paise / 100)}~ ` : ''}*₹${Math.round(plan.price_paise / 100)}* (only if you want it)\n\n`
    : '';
  await send.buttons(mobile, INTRO + price + OWNER_TERMS,
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

  // Rebuilt first if missing or printed with an older layout (pay/rebuild.js).
  const file = r.id ? await require('../pay/rebuild').ensureFile('vehicle_reports', r.id).catch((e) => {
    console.error('[wa] report %s rebuild: %s', r.report_number, e.message);
    return r.pdf_path;
  }) : r.pdf_path;
  const sent = file
    ? await send.document(mobile, file, { filename: `${r.report_number}.pdf`, caption })
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
/* Asking not to be messaged, in the words people actually use (user, 2026-09-30). */
const OPT_OUT_RE = new RegExp([
  "\\b(don'?t|do not|dont|pls don'?t|please don'?t)\\s+(message|msg|text|contact|disturb|send)",
  '\\bstop\\s+(messag|msg|sending|texting|spam)',
  '\\bno more (messages|msgs|texts)\\b', '\\bunsubscribe\\b', '\\bopt[ -]?out\\b',
  '\\bblock (me|this|you|number)\\b', '\\bleave me alone\\b',
  '\\b(message|msg|sms) (mat|na) (karo|kar|bhejo|bhej)\\b', '\\bmat bhejo\\b',
  '\\b(band|bandh) karo\\b', '\\bmessage band\\b', '\\bpareshan mat\\b',
].join('|'), 'i');

/*
 * AFTER STOP, ONE QUESTION (user, 2026-10-02). STOP takes effect first — the
 * Terms promise it, Meta's rules and the DPDP Act expect it — and only then one
 * message asks why, with an Undo for anyone who did not mean it. Nothing more
 * is sent unless they answer: this reply is inside the window they opened.
 */
const STOP_WHY = {
  'stopwhy:many': 'Too many messages',
  'stopwhy:useless': 'Not useful for me',
  'stopwhy:price': 'Price is too high',
  'stopwhy:data': 'Wrong or missing data',
  'stopwhy:other': 'Something else',
};
const STOP_AFTER = 'If you write to us, we will still reply. Reply *START* any time to hear from us again.';
async function stopped(mobile, lead) {
  const out = await send.list(mobile, {
    body: `${lead}\n\n${STOP_AFTER}\n\n_May we ask why? One tap helps us improve._ 🙏`,
    button: 'Tell us why',
    sectionTitle: 'Why STOP?',
    rows: [
      ...Object.entries(STOP_WHY).map(([id, title]) => ({ id, title })),
      { id: 'stop_undo', title: 'Undo — keep messages', description: 'I did not mean to stop' },
    ],
  }).catch(() => ({ ok: false }));
  if (!out?.ok) await send.text(mobile, `${lead}\n\n${STOP_AFTER}`);
}

/* Unhappy words — the person is not asking for a vehicle (user, 2026-09-30). */
const UNHAPPY_RE = /\b(fraud|froud|scam|cheat(er|ing)?|chor|loot|bakwas|bakvas|faltu|bekar|bekaar|worst|useless|waste|fake|dhoka|thag)\b/i;

/* Hold every reminder for a day after someone sounds unhappy or is chatting,
   not sending a number: a reminder then is chasing, not helping. */
const quietNudges = (mobile) => db.query(
  `UPDATE whatsapp_sessions SET context = context || jsonb_build_object('no_nudge_at', now()), modified_at = now()
    WHERE mobile = $1`, [mobile]).catch(() => {});

async function handle(session, message, mobile) {
  const intent = intentOf(message);
  const state = session.state || 'new';

  /*
   * FROM THE WEBSITE (user, 2026-09-25). Every WhatsApp link on gaadipe.in
   * ends in the visitor's code — "Hi #K7Q2M" — because a wa.me link can carry
   * nothing else. Read it here, tie this chat to that browser (source,
   * campaign, pages seen), then take it out, so "Hi #K7Q2M" is handled
   * exactly as "Hi".
   */
  const webCode = intent.kind === 'text' && track.CODE_RE.exec(intent.text || '');
  if (webCode) {
    const u = await db.one(`SELECT id FROM users WHERE mobile = $1`, [mobile]).catch(() => null);
    const v = await track.linkByCode(webCode[1], { mobile, userId: u?.id });
    if (v) {
      track.fire({
        key: `wa_link:${mobile}:${v.visitor_id}`, name: 'whatsapp_linked_to_web', channel: 'whatsapp',
        visitorId: v.visitor_id, userId: u?.id || null, mobile,
        source: v.last_touch?.source || v.first_touch?.source || null,
        campaign: v.last_touch?.campaign || v.first_touch?.campaign || null,
        meta: { code: webCode[1] },
      });
    }
    intent.text = intent.text.replace(track.CODE_RE, '').replace(/\s+/g, ' ').trim() || 'Hi';
  }

  /*
   * STOP AND START (user, 2026-09-25). The Terms say: reply STOP and we stop
   * messaging you, other than to reply, until you reply START. Read here,
   * before referrals, buttons and the state machine, because it must work from
   * anywhere — typed, or as the "Stop promotions" button Meta puts on
   * marketing templates. send.js refuses every template to a number that said
   * STOP; this records it and says so.
   */
  // The answer to "May we ask why?" after STOP (stopped() above), or its Undo.
  if (STOP_WHY[intent.id] || intent.id === 'stop_undo') {
    if (intent.id === 'stop_undo') {
      await db.query(`UPDATE whatsapp_sessions SET wa_opt_out_at = NULL, modified_at = now() WHERE mobile = $1`, [mobile]);
      await funnel(mobile, 'opt_in', { undo: true });
      console.log('[wa] %s undid STOP', mobile);
      await doors(mobile, 'Welcome back 👋 — GaadiPe will message you again.');
      return;
    }
    if (intent.id === 'stopwhy:other') {
      await setState(mobile, 'stop_reason', 'asked why STOP');
      await send.text(mobile, 'Please tell us in one line what went wrong — every message is read. 🙏');
      return;
    }
    await funnel(mobile, 'opt_out_reason', { reason: STOP_WHY[intent.id] });
    await send.text(mobile, 'Thank you for telling us 🙏 — it really helps. You will not hear from us unless you write.');
    return;
  }

  /*
   * UNHAPPY? TELL THE ADMIN (user, 2026-10-03, util/unhappy.js). Money
   * worries, anger or "no report" in any message reach the admin at once —
   * the bot's own reply below is unchanged.
   */
  if (intent.kind === 'text' && intent.text) {
    const why = require('../util/unhappy').kind(intent.text);
    if (why) require('../util/unhappy').flag({ mobile, said: intent.text, why }).catch(() => {});
  }

  /*
   * "DELETE MY DATA" (user, 2026-10-03; DPDP Act). A request for the admin
   * (admin/dataRequests.js), and a plain answer: what will be deleted and what
   * the law makes GaadiPe keep. Messages from GaadiPe stop once it is done.
   */
  if (/\b(delete|remove|erase|wipe|clear)\b[\w\s']{0,25}\b(data|details|information|info|account|records?)\b|\bdata\s+(delete|hatao|mitao|remove)\b/i.test(intent.text || '')) {
    const user = await store.upsertUser(mobile).catch(() => null);
    const r = await require('../admin/dataRequests').request({ mobile, userId: user?.id, said: intent.text });
    await funnel(mobile, 'data_delete_request', { created: r.created });
    await send.text(mobile, r.created
      ? '✅ Your request to delete your personal data is received.\n\n'
        + 'We will delete your name, chats, feedback and the vehicles you checked, and confirm it here. '
        + 'Payment records and GST invoices are kept for the period the law requires.\n\n'
        + 'If you sent this by mistake, just write to us.'
      : 'Your request to delete your personal data is already with us — we will confirm here once it is done. 🙏');
    return;
  }

  if (/^(stop|unsubscribe|stop promotions)\s*$/i.test(intent.text)) {
    await db.query(
      `UPDATE whatsapp_sessions SET wa_opt_out_at = now(), modified_at = now()
        WHERE mobile = $1`, [mobile]);
    await funnel(mobile, 'opt_out');
    console.log('[wa] %s replied STOP — no more messages from us', mobile);
    await stopped(mobile, 'Done ✅ — GaadiPe will not message you any more.');
    return;
  }
  /*
   * "DON'T MESSAGE ME" IS STOP TOO (user, 2026-09-30). Someone wrote "Don't
   * message me" after seeing the price; the bot read it as a vehicle number and
   * the payment reminder went out anyway, which is what made them reply STOP.
   * Plain-language refusals — English, Hindi and Hinglish — now opt out at once.
   */
  // (Not while they are typing why they said STOP — "stop messaging me" is then the reason.)
  if (state !== 'stop_reason' && OPT_OUT_RE.test(intent.text || '')) {
    await db.query(
      `UPDATE whatsapp_sessions SET wa_opt_out_at = now(), modified_at = now()
        WHERE mobile = $1`, [mobile]);
    await funnel(mobile, 'opt_out', { said: String(intent.text).slice(0, 60) });
    console.log('[wa] %s asked not to be messaged — treated as STOP', mobile);
    await stopped(mobile, 'Understood 🙏 — GaadiPe will not message you any more. Nothing is charged unless you pay.');
    return;
  }

  if (/^start\s*$/i.test(intent.text)) {
    const { rowCount } = await db.query(
      `UPDATE whatsapp_sessions SET wa_opt_out_at = NULL, modified_at = now()
        WHERE mobile = $1 AND wa_opt_out_at IS NOT NULL`, [mobile]);
    if (rowCount) {
      await funnel(mobile, 'opt_in');
      console.log('[wa] %s replied START — messages on again', mobile);
      await send.text(mobile, 'Welcome back 👋 — GaadiPe will message you again.');
    }
    // …and START is also a greeting, so carry on to the beginning below.
  }

  /*
   * OWNER VERIFICATION BY RC PHOTO (user, 2026-10-04, owners/photo.js).
   * A decision the customer has not heard yet (their window was shut when the
   * admin decided) is told first, with its reward, whatever they wrote.
   * A photo or PDF sent while a claim waits for one is that claim's RC.
   */
  const ownerTold = await ownerPhoto.deliverPending(mobile).catch((e) => { console.error('[wa] owner notice for %s: %s', mobile, e.message); return null; });
  // Checks of their vehicle while their chat was shut, as one summary (owners/checkAlerts.js).
  await require('../owners/checkAlerts').deliverPending(mobile).catch((e) => console.error('[wa] check alerts for %s: %s', mobile, e.message));
  /*
   * THE TWO OWNER TEMPLATES' BUTTONS (2026-10-04). A template's quick reply
   * arrives as its text, so both are matched by words as well as by id:
   *   gp_owner_verification_update_v1  "See details" — the decision itself was just
   *                              told above (deliverPending); if there was
   *                              nothing left to tell, show their vehicles.
   *   gp_vehicle_check_alert_v1        "Hide my vehicle" / "That's fine" /
   *                              "Stop these alerts" (and typed ALERTS ON).
   */
  if (await require('../owners/checkAlerts').button(mobile, { id: intent.id, text: intent.text })) return;
  if (!Object.values(BTN).includes(intent.id) && /^see details$/i.test(intent.text || '')
      && await db.one(`SELECT 1 AS x FROM vehicle_owner_claims WHERE mobile = $1 AND method = 'rc_photo' LIMIT 1`, [mobile])) {
    if (!ownerTold?.sent) await askOwnedVehicle(mobile);
    return;
  }
  if ((message.type === 'image' || message.type === 'document') && await ownerPhoto.openClaim(mobile)) {
    await receiveRcPhoto(mobile, message);
    return;
  }

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
  // REFERRAL IS OFF IN WHATSAPP (user, 2026-09-29: no free reports). A message
  // still carrying an old link's code is welcomed like any first "hi" — nothing
  // is attached, so no reward can be earned through it.
  if (refer.codeFromText(intent.text)) {
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

    if (String(intent.id || '').startsWith('ownv:')) {
      await startOwnerClaim(mobile, intent.id.slice(5), message);
      return;
    }

    if (String(intent.id || '').startsWith('veh:')) {
      await openVehicle(mobile, intent.id.slice(4), message, 'chosen from list');
      return;
    }

    /*
     * "Check a vehicle" on a TEMPLATE (user, 2026-09-25) — the announcement's
     * quick reply. Its payload is the button's own text, not one of our ids,
     * so it would fall to the default and show the terms again even to
     * someone who agreed yesterday. Someone who has accepted the Terms in force
     * is asked for the number straight away; anyone else sees the terms first.
     */
    if (!Object.values(BTN).includes(intent.id) && /^check (a |my )?vehicle$/i.test(intent.text)) {
      const agreed = await agreedVersion(mobile);
      if (agreed && agreed === await policyVersion()) {
        await setState(mobile, 'owner_start', 'template: check a vehicle');
        await send.text(mobile, 'Send me the vehicle number — like *KA01XX1234*.');
      } else {
        await start(mobile);
      }
      return;
    }

    /*
     * "Get full report" on the thank-you template (user, 2026-09-26). Their
     * latest vehicle is opened: a report they already bought comes as its PDF,
     * anything else shows the basic details with the Full report ₹19 button.
     * No vehicle yet: asked for one. Not agreed to the Terms in force: terms.
     */
    if (!Object.values(BTN).includes(intent.id) && /^get (the |a )?full report$/i.test(intent.text)) {
      const agreed = await agreedVersion(mobile);
      if (!agreed || agreed !== await policyVersion()) { await start(mobile); return; }
      const user = await store.upsertUser(mobile);
      const [last] = await store.checkedBy(user.id, 1);
      if (last) {
        await openVehicle(mobile, last.reg_no, message, 'template: get full report');
      } else {
        await setState(mobile, 'owner_start', 'template: get full report');
        await send.text(mobile, 'Send me the vehicle number — like *KA01XX1234* — and I will show you its full report.');
      }
      return;
    }

    /*
     * Other template quick replies (user, 2026-09-30): "My reports" on an alert
     * showed a paying customer the terms again. The payload is the button text,
     * so it is matched by words.
     */
    if (!Object.values(BTN).includes(intent.id)) {
      if (/^my (vehicle )?reports?$|^my vehicles?$/i.test(intent.text)) { await myVehicles(mobile, message); return; }
      if (/^(support|help|contact( us)?)$/i.test(intent.text)) { await sendSupportLink(mobile); return; }
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
          + '_To check a vehicle you can also just send its number, like *KA01XX1234*._');
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

      // The old "RC verified" button, from messages sent long ago, opens the
      // owner verification that replaced it.
      case BTN.VERIFY_RC:
      case BTN.OWNER_VERIFY:
        await askOwnedVehicle(mobile);
        return;

      case BTN.OWNER_HIDE:
      case BTN.OWNER_SHOW: {
        const reg = (await sessionContext(mobile)).ov_reg || (await owners.mine(mobile))[0]?.reg_no;
        const hide = intent.id === BTN.OWNER_HIDE;
        if (!reg || !await owners.setHidden(mobile, reg, hide)) {
          await doors(mobile, 'I could not find a verified vehicle on this number. Tap *More* → *I own a vehicle* to verify one.');
          return;
        }
        await send.buttons(mobile, hide
          ? `🙈 Done — *${reg}* is now *hidden*. Other people checking it on GaadiPe are told the owner keeps it private. You still see it.`
          : `👀 Done — *${reg}* can be checked by others again.`,
        [{ id: hide ? BTN.OWNER_SHOW : BTN.OWNER_HIDE, title: hide ? 'Show it again' : 'Hide from others' },
          { id: BTN.CHECK_ANOTHER, title: 'Check vehicle' }]);
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
        await send.text(mobile, 'Send me the vehicle number — like *KA01XX1234*.');
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
        if (!razorpay.configured() || !(await require('../util/flags').on('payments'))) {
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

        // An old "Start free trial" button, or a vehicle picked to watch,
        // while the trial is off: monitoring comes with the ₹19 report.
        if (!r.ok && r.reason === 'disabled') {
          await setState(mobile, 'owner_menu', 'trial is off');
          await send.buttons(mobile,
            reg ? `Monitoring comes with the full report — *₹19 for ${reg}*, one-time.`
              : 'Monitoring comes with the full report — ₹19 per vehicle, one-time.',
            [...(reg ? [{ id: BTN.BUY_REPORT, title: 'Full report ₹19' }] : []),
             { id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' }]);
          return;
        }
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

        /*
         * A GIFT FIRST (user, 2026-10-04, admin/gifts.js): a paying customer
         * the admin gave free reports to uses one here instead of paying —
         * the same report, sent the same way.
         */
        const gifts = require('../admin/gifts');
        await gifts.ensureAuto(user.id).catch(() => 0);
        if ((await gifts.available(user.id)).length) {
          await send.text(mobile, `🎁 Using one of your free full reports for *${vehicle.reg_no}* … ⏳`);
          const g = await gifts.use(user.id, vehicle.reg_no);
          if (g.ok) {
            await funnel(mobile, 'gift_used', { reg_no: vehicle.reg_no, left: g.left });
            await send.text(mobile, g.left
              ? `🎁 That was a free report from GaadiPe — you have *${g.left}* more to use. Send any vehicle number to use the next one.`
              : '🎁 That was your last free report from GaadiPe. Thank you for being with us! 🙏');
            return;
          }
          console.error('[wa] gift report for %s failed: %s — offering the paid one', vehicle.reg_no, g.error);
        }

        // Every precondition is checked BEFORE an order exists, so a missing
        // setting never leaves an orphan order behind.
        const plan = await billing.reportPlan();
        if (!plan || !razorpay.configured() || !baseUrl() || !(await require('../util/flags').on('payments'))) {
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

      case BTN.FLEET:
        await sendFleetInfo(mobile);
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

      default: {
        // An unknown id means a button from an older version of the flow, or a
        // template quick reply. Someone who agreed to the Terms in force is
        // never shown them again (user, 2026-09-30) — they get the menu.
        const agreed = await agreedVersion(mobile);
        if (agreed && agreed === await policyVersion()) {
          await doors(mobile, 'What would you like to do? You can also just send a vehicle number, like *KA01XX1234*.');
        } else {
          await start(mobile);
        }
        return;
      }
    }
  }

  /* ------------------------------------------------- documents on request */

  // "invoice" and "report" are typed, not tapped, because they are asked for
  // days later — long after any button has scrolled out of view.
  // No referral in WhatsApp (user, 2026-09-29): typing "refer" is no longer a
  // command, and no free report is offered here.

  if (/^(invoice|bill|receipt)s?\s*$/i.test(intent.text)) {
    await sendInvoices(mobile);
    return;
  }
  if (/^(report|pdf|document)s?\s*$/i.test(intent.text)) {
    await sendReports(mobile);
    return;
  }
  // Owner verification by word as well as from the menu — only while it is on.
  if (/^(verify|verify owner|i own (a|my|this) vehicle|owner verification)\s*$/i.test(intent.text) && await owners.enabled()) {
    await askOwnedVehicle(mobile);
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

    // The "Something else" reason after STOP (stopped() above): stored, thanked, done.
    case 'stop_reason': {
      await funnel(mobile, 'opt_out_reason', { reason: 'Something else', said: String(intent.text || `[${message.type}]`).slice(0, 300) });
      await setState(mobile, 'owner_start', 'STOP reason given');
      await send.text(mobile, 'Thank you for telling us 🙏 — it really helps. You will not hear from us unless you write.');
      return;
    }

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

      /*
       * NOT A VEHICLE NUMBER (user, 2026-09-30). Every number plate has a
       * digit, so text without one is someone talking — "You are fraud",
       * "Faltu Giri bakwas" — and answering "YO is not a State code" reads as
       * mockery. Reply as a person would, and hold the reminders.
       */
      const said = String(intent.text || '').trim();
      if (said && !/\d/.test(said)) {
        await quietNudges(mobile);
        const plan = await billing.reportPlan().catch(() => null);
        const price = plan ? ` at ₹${Math.round(plan.price_paise / 100)}` : '';
        if (UNHAPPY_RE.test(said)) {
          await send.buttons(mobile,
            'Sorry this was not what you expected 🙏\n\n'
            + `The basic check is *free*. The full report is *optional*${price} — nothing is charged unless you choose to pay.\n\n`
            + 'If you would rather not continue, that is completely fine. Reply *STOP* and we will not message you.',
            [{ id: BTN.CHECK_ANOTHER, title: 'Check a vehicle' },
             { id: BTN.FEEDBACK, title: 'Tell us why' }]);
        } else {
          await doors(mobile,
            'I can check any Indian vehicle for you — just send its number, like *KA01XX1234*.\n\n'
            + '_For anything else, tap More → Support._');
        }
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

    // A chat left in the old "RC verified" step starts the new one.
    case 'verify_rc':
      await askOwnedVehicle(mobile);
      return;

    case 'owner_verify_reg': {
      const parsed = plate.parse(intent.text);
      if (!parsed.ok) {
        await send.text(mobile, 'Please send the vehicle number as it is on the RC — like *KA01XX1234*. Send *hi* to stop.');
        return;
      }
      await startOwnerClaim(mobile, parsed.regNo, message);
      return;
    }

    // Waiting for the RC photo (photos are taken above, before the states).
    case 'owner_verify_photo': {
      if (/^(cancel|no|later|not now)\s*$/i.test(intent.text)) {
        await db.query(
          `UPDATE vehicle_owner_claims SET status = 'failed', counted = false, note = 'cancelled', modified_at = now()
            WHERE mobile = $1 AND status = 'pending'`, [mobile]);
        await doors(mobile, 'No problem — you can verify any time from *More* → *I own a vehicle*.');
        return;
      }
      const parsed = plate.parse(intent.text || '');
      if (parsed.ok) { await deliverReport(mobile, parsed.regNo, message); return; }
      const ctx = await sessionContext(mobile);
      await send.text(mobile, `📸 Please send a *photo of the RC* for *${ctx.ov_reg || 'your vehicle'}* here — tap 📎 or the camera. `
        + 'Send *cancel* to stop.\n\n🔒 Deleted as soon as it is checked.');
      return;
    }

    case 'owner_verify_chassis': {
      const ctx = await sessionContext(mobile);
      const r = ctx.ov_claim ? await owners.answerChassis(ctx.ov_claim, intent.text) : { ok: false };
      if (!r.ok) { await askOwnedVehicle(mobile, 'That verification timed out — let us start again.'); return; }
      await setState(mobile, 'owner_verify_second', 'chassis given');
      await send.text(mobile, {
        policy: '*Step 2 of 2:* type your *insurance policy number* — it is on your insurance paper or e-policy.',
        engine: '*Step 2 of 2:* type the *engine number* (Engine No.) from your RC.',
      }[r.second] || '*Step 2 of 2:* type your *insurance policy number* (from your insurance paper) — or, if you do not have it, the *engine number* from your RC.');
      return;
    }

    case 'owner_verify_second': {
      const ctx = await sessionContext(mobile);
      const r = ctx.ov_claim ? await owners.answerSecond(ctx.ov_claim, intent.text) : { ok: false, reason: 'lost' };
      const reg = ctx.ov_reg;
      if (r.ok) {
        await setState(mobile, 'owner_menu', 'owner verified');
        await funnel(mobile, 'owner_verified', { reg_no: reg });
        await send.buttons(mobile,
          `✅ *${reg}* is now *Owner verified* — it matched the Government record.\n\n`
          + 'You will see the badge when you check it. If you like, you can *hide it from other people\'s checks* — '
          + 'they will be told the owner keeps it private, and you will still see it.',
          [{ id: BTN.OWNER_HIDE, title: 'Hide from others' }, { id: BTN.CHECK_ANOTHER, title: 'Check vehicle' }]);
        return;
      }
      if (r.reason === 'lost') { await askOwnedVehicle(mobile, 'That verification timed out — let us start again.'); return; }
      await setState(mobile, 'owner_menu', `owner verification ${r.reason}`);
      await funnel(mobile, 'owner_verify_failed', { reg_no: reg, locked: r.reason === 'locked' });
      if (r.reason === 'locked') {
        await doors(mobile,
          `❌ That did not match the Government record for *${reg}*, and that was the last try for now.\n\n`
          + `You can try again after *${istTime(r.lockedUntil)}*. If the RC is yours and it still does not match, `
          + 'email a photo of the RC to support@gaadipe.in and we will check it by hand.');
        return;
      }
      await send.buttons(mobile,
        `❌ That did not match the Government record for *${reg}*. ${r.attemptsLeft} tr${r.attemptsLeft === 1 ? 'y' : 'ies'} left.\n\n`
        + 'Check the numbers on your RC and insurance paper — letters and numbers exactly as printed — and try again.',
        [{ id: `ownv:${reg}`, title: 'Try again' }, { id: BTN.MENU, title: 'More' }]);
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

/** The free check for a number on the waiting list, now the records are back (jobs/waitlist.js). */
const checkFromWaitlist = (mobile, regNo) => openVehicle(mobile, regNo, { type: 'system' }, 'waitlist: records service back');

module.exports = { handle, welcome, recordConsent, checkFromWaitlist, BTN, _sendValidReport: (m, r) => sendValidReport(m, r) };
