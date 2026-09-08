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
 *   owner_swap       they already watch a vehicle; offered the swap
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
  SWAP_YES: 'swap_yes',
  SWAP_NO: 'swap_no',
  SUBSCRIBE: 'subscribe',
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
     JSON.stringify({ mobile, role, documents, channel: 'whatsapp', at: new Date().toISOString() })]);
  await db.query(
    `UPDATE whatsapp_sessions
        SET context = context || $2::jsonb, modified_at = now()
      WHERE mobile = $1`,
    [mobile, JSON.stringify({ role, consent_at: new Date().toISOString(), consent_documents: documents })]);
  console.log('[wa] consent %s by %s', role, mobile);
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
 * Start or move the free trial.
 *
 * The rules, and the reason each exists:
 *   one trial per mobile number, ever — otherwise it is not a trial
 *   one vehicle at a time          — keeps the decision at a single ₹49
 *   one swap for the whole trial   — enough to fix a mistake, not enough to
 *                                    monitor a series of vehicles for free
 *
 * The clock never restarts on a swap: the trial ends trial_minutes after it
 * began, whatever happens in between. That length is a setting, so a test run
 * sets it to 1 and watches the entire lifecycle — check, notice, expiry —
 * happen in a couple of minutes, running exactly the code production runs.
 */
async function startTrial(userId, regNo, { swappedFrom } = {}) {
  const vehicle = await db.one(`SELECT id FROM vehicles WHERE reg_no = $1`, [regNo]);
  if (!vehicle) return { ok: false, reason: 'unknown_vehicle' };

  const prior = await db.one(
    `SELECT detail->>'started_at' AS started_at
       FROM event_log
      WHERE kind = 'trial_started' AND user_id = $1
      ORDER BY id LIMIT 1`, [userId]);

  // One trial per mobile number, ever. A swap moves an existing trial, so it is
  // allowed to find a prior one; anything else must not.
  //
  // This is checked explicitly rather than relied on as a side effect. Reusing
  // the original start time would already make a second trial expire the moment
  // it began — correct by accident, and the kind of thing that quietly breaks
  // the day someone changes how the start time is derived.
  if (!swappedFrom && prior) return { ok: false, reason: 'trial_used' };

  const swaps = await db.one(
    `SELECT count(*)::int AS n FROM event_log
      WHERE kind = 'trial_swapped' AND user_id = $1`, [userId]);

  const allowedSwaps = await settings.num('trial_swaps_allowed', 1);
  if (swappedFrom && swaps.n >= allowedSwaps) return { ok: false, reason: 'swap_used' };

  const minutes = await settings.num('trial_minutes', 7 * 24 * 60);
  const checkEvery = await settings.num('watch_check_interval_minutes', 24 * 60);

  // A swap keeps the original end time; a fresh trial starts the clock now.
  const startedAt = prior?.started_at ? new Date(prior.started_at) : new Date();
  const endsAt = new Date(startedAt.getTime() + minutes * 60 * 1000);

  await db.tx(async (c) => {
    if (swappedFrom) {
      await c.query(
        `UPDATE watches SET is_active = false, modified_at = now()
          WHERE user_id = $1 AND is_active`, [userId]);
    }
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
      [userId, vehicle.id, swappedFrom ? 'trial_swapped' : 'trial_started',
       JSON.stringify({ reg_no: regNo, from: swappedFrom || null,
                        started_at: startedAt.toISOString(),
                        ends_at: endsAt.toISOString(),
                        trial_minutes: minutes })]);
    await c.query(
      `UPDATE user_vehicles SET relation = 'owned'
        WHERE user_id = $1 AND vehicle_id = $2`, [userId, vehicle.id]);
  });

  return { ok: true, endsAt, endsOn: endsAt, minutes,
           swapsLeft: Math.max(0, allowedSwaps - swaps.n - (swappedFrom ? 1 : 0)) };
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

  let data;
  try {
    data = await gateway.full(regNo);
  } catch (e) {
    console.error('[wa] lookup failed for %s: %s', regNo, e.message);
    data = null;
  }

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

  await send.text(mobile, report.build(data));

  const watching = await store.watchedBy(user.id);
  const already = watching.find(w => w.reg_no === regNo);

  if (already) {
    await setState(mobile, 'owner_menu', 'already watching this vehicle');
    await send.buttons(mobile,
      `You are already watching *${regNo}*. I will message you if anything changes.`,
      [{ id: BTN.CHECK_ANOTHER, title: 'Check another' }]);
    return;
  }

  if (watching.length) {
    // A trial covers one vehicle. Someone checking a second one is either
    // curious or picked the wrong vehicle to begin with — offer the swap
    // rather than making them ask for it.
    const current = watching[0];
    await db.query(
      `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now()
        WHERE mobile = $1`,
      [mobile, JSON.stringify({ swap_to: regNo, swap_from: current.reg_no })]);
    await setState(mobile, 'owner_swap', 'offered swap');
    await send.buttons(mobile,
      `You are currently watching *${current.reg_no}*.\n\n`
      + `Your free trial covers one vehicle. Would you like to watch *${regNo}* instead?\n\n`
      + '_Checking any vehicle is always free — this only changes which one I keep an eye on._',
      [{ id: BTN.SWAP_YES, title: 'Watch this instead' },
       { id: BTN.SWAP_NO,  title: 'Keep current' }]);
    return;
  }

  // Someone whose trial has already run is not offered another one. Being
  // offered a "free trial" you cannot have, and finding out only after tapping,
  // is worse than not being offered it.
  const used = await trialUsed(user.id);
  const days = Math.round(await settings.num('trial_minutes', 10080) / (60 * 24)) || 1;
  const price = Math.round(await settings.num('first_payment_paise', 4900) / 100);

  await setState(mobile, 'owner_menu', 'report delivered');

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
    + 'if a new challan appears or a document is about to expire.',
    [{ id: BTN.TRIAL_START,   title: 'Start free trial' },
     { id: BTN.CHECK_ANOTHER, title: 'Check another' }]);
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

      case BTN.CHECK_ANOTHER:
        await setState(mobile, 'owner_start', 'checking another');
        await send.text(mobile, 'Sure — send me the next vehicle number.');
        return;

      case BTN.SUBSCRIBE: {
        const price = Math.round(await settings.num('first_payment_paise', 4900) / 100);
        await setState(mobile, 'owner_menu', 'wants to subscribe');
        await send.text(mobile,
          `Payment is being set up and will be ready shortly — ₹${price} for 28 days.\n\n`
          + 'I will message you the moment it is live. Meanwhile, checking any vehicle '
          + 'is free: just send me a number.');
        return;
      }

      case BTN.TRIAL_START: {
        const user = await store.upsertUser(mobile);
        const reg = await pendingReg(mobile);
        const r = await startTrial(user.id, reg);
        if (!r.ok && r.reason === 'trial_used') {
          const price = Math.round(await settings.num('first_payment_paise', 4900) / 100);
          await setState(mobile, 'owner_menu', 'trial already used');
          await send.buttons(mobile,
            'You have already used your one free trial on this number.\n\n'
            + `To keep watching *${reg}*, it is ₹${price} for 28 days. `
            + 'Checking any vehicle stays free.',
            [{ id: BTN.SUBSCRIBE,     title: `Continue for ₹${price}` },
             { id: BTN.CHECK_ANOTHER, title: 'Check another' }]);
          return;
        }
        if (!r.ok) {
          await send.text(mobile, 'Something went wrong starting the trial. Please reply *hi* and try again.');
          return;
        }
        await setState(mobile, 'trial_active', 'trial started');
        await send.text(mobile,
          `Done. ✅ I am now watching *${reg}* until *${until(r.endsAt, r.minutes)}*.\n\n`
          + 'I check every day and message you only if something needs your attention '
          + '— a new challan, or a document about to expire.\n\n'
          + 'Nothing to pay, and nothing will be charged automatically.');
        return;
      }

      case BTN.SWAP_YES: {
        const ctx = await sessionContext(mobile);
        const user = await store.upsertUser(mobile);
        const r = await startTrial(user.id, ctx.swap_to, { swappedFrom: ctx.swap_from });
        if (!r.ok && r.reason === 'swap_used') {
          await setState(mobile, 'trial_active', 'swap already used');
          await send.text(mobile,
            'You have already swapped once during this trial, so I will keep watching '
            + `*${ctx.swap_from}*.\n\n`
            + 'Checking any vehicle is still free — just send me a number any time.');
          return;
        }
        if (!r.ok) {
          await send.text(mobile, 'Something went wrong. Please reply *hi* and try again.');
          return;
        }
        await setState(mobile, 'trial_active', 'trial swapped');
        await send.text(mobile,
          `Done. ✅ I am now watching *${ctx.swap_to}* instead of *${ctx.swap_from}*, `
          + `until *${until(r.endsAt, r.minutes)}*.\n\n`
          + '_This was your one swap for this trial._');
        return;
      }

      case BTN.SWAP_NO: {
        const ctx = await sessionContext(mobile);
        await setState(mobile, 'owner_menu', 'kept current vehicle');
        await send.text(mobile,
          `No change made — I am still watching *${ctx.swap_from}*.

`
          + 'Reply *hi* any time to check another vehicle.');
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
    case 'owner_swap':
    case 'trial_active': {
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
