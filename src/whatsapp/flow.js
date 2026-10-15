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
  AGREE_OWNER_OFFERS: 'agree_owner_offers',
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
  OFFERS_YES: 'offers_yes',
  OFFERS_NO: 'offers_no',
  // The menu, as on the website's chat (user, 2026-10-12).
  MY_VEHICLES: 'my_vehicles',
  MY_MONITORING: 'my_monitoring',
  EMAIL: 'menu_email',
  EMAIL_CHANGE: 'email_change',
  EMAIL_LATER: 'email_later',     // "Not now" on the email tip (emailNudge, 2026-10-15)
  EMAIL_RESEND: 'email_resend',
  WHAT_GET: 'what_get',
  TERMS: 'menu_terms',
  STOP_MENU: 'menu_stop',
  STOP_CONFIRM: 'stop_confirm',
  DELETE_DATA: 'delete_data',
  STOP_CANCEL: 'stop_cancel',
  OFFERS_NOW: 'menu_offers',
};

/*
 * TIPS & OFFERS ON WHATSAPP — ASKED, NEVER ASSUMED (user, 2026-10-09, after the
 * spam disable: marketing only to people who opted in). Once, in a conversation
 * the customer started, after their first vehicle result: a reply, so no template
 * and nothing unsolicited. "Yes" is recorded with these exact words (the same
 * opt-in as the website's box, site/auth.setPromoConsent); "No" is remembered and
 * never asked again. STOP withdraws it on every channel.
 */
const OFFERS_ASK = 'One quick question: would you like occasional *tips & offers* from GaadiPe here on WhatsApp? At most one a week. Reply *STOP* any time to stop them.';
const OFFERS_WORDS = 'Yes — send me occasional tips & offers from GaadiPe on WhatsApp (at most one a week; STOP any time).';

async function askOffersOnce(mobile) {
  if (await send.optedInToOffers(mobile)) return;
  const s = await db.one(`SELECT context->>'offers_asked_at' AS asked FROM whatsapp_sessions WHERE mobile = $1`, [mobile]).catch(() => null);
  if (s?.asked) return;
  await db.query(
    `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1`,
    [mobile, JSON.stringify({ offers_asked_at: new Date().toISOString() })]);
  await send.buttons(mobile, OFFERS_ASK,
    [{ id: BTN.OFFERS_YES, title: 'Yes, send offers' }, { id: BTN.OFFERS_NO, title: 'No thanks' }]);
}

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
  return reply(mobile, body, ['check', 'reports', 'more']);
}

/*
 * EVERY REPLY ENDS WITH A WAY ON (user, 2026-10-12: "whatever the replies you have,
 * incorporate 1 or 2 or 3 replies to engage user"). A message that is not waiting
 * for something typed — a number, a photo, feedback — carries reply buttons. They
 * need the 24-hour window and a body of at most 1024 characters; otherwise the
 * same words go as plain text, so nothing is ever lost.
 */
const NEXT = {
  check:   { id: BTN.CHECK_ANOTHER, title: 'Check vehicle' },
  other:   { id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' },
  reports: { id: BTN.MY_REPORTS,    title: 'My vehicle reports' },
  menu:    { id: BTN.MENU,          title: 'Menu' },
  more:    { id: BTN.MENU,          title: 'More' },
  support: { id: BTN.SUPPORT,       title: 'Support' },
};
async function reply(mobile, body, keys = ['check', 'menu']) {
  const list = keys.map((k) => (typeof k === 'string' ? NEXT[k] : k)).filter(Boolean).slice(0, 3);
  const out = String(body).length <= 1024
    ? await send.buttons(mobile, body, list).catch(() => ({ ok: false }))
    : { ok: false };
  return out.ok ? out : send.text(mobile, body);
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

  // Terms & privacy live here now (2026-10-13): their menu row went to "Current offers".
  await send.text(mobile,
    '💬 *Help & support*\n\n'
    + 'Tell us what is wrong and we will get back to you here, with a ticket number.\n\n'
    + `Open this to write to us (the link works for ${hours} hours):\n${url}\n\n`
    + `📜 Terms: ${SITE}/terms\n🔒 Privacy: ${SITE}/privacy\n💸 Refunds: ${SITE}/refund`);

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
        AND uv.hidden_at IS NULL            -- removed from My vehicles (here or on the website)
      ORDER BY uv.last_checked_at DESC NULLS LAST
      LIMIT 10`, [user.id]);

  if (!rows.length) {
    await doors(mobile,
      'You have not checked any vehicle yet.\n\n'
      + 'Send me a vehicle number and I will look it up — the basics are free.');
    return;
  }

  /*
   * Always the list, now with "Remove a vehicle" as its last row (user, 2026-10-13) —
   * even for one vehicle, which used to open straight away, so the way to remove it
   * is always where the vehicles are. WhatsApp allows ten rows: nine vehicles.
   */
  const more = rows.length > 9;
  const shown = rows.slice(0, 9);
  const out = await send.list(mobile, {
    body: more
      ? 'Which vehicle? These are your most recent — for any other, just send me its number.'
      : 'Which vehicle?',
    button: 'My vehicles',
    sectionTitle: 'Checked by you',
    rows: [...shown.map((r) => ({
      id: `veh:${r.reg_no}`,
      title: r.reg_no,
      description: [
        [r.maker, r.model].filter(Boolean).join(' ').slice(0, 30),
        r.has_report ? 'full report (PDF)' : 'basic details',
      ].filter(Boolean).join(' · '),
    })), { id: 'rm_pick', title: '🗑 Remove a vehicle', description: 'Take one off your list — its alerts stop' }],
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

/* ─────────────── REMOVE A VEHICLE (user, 2026-10-13; vehicle/remove.js) ── */

/** "Remove a vehicle": which one? */
async function removePick(mobile) {
  const user = await store.upsertUser(mobile);
  const { rows } = await db.query(
    `SELECT v.reg_no, v.maker, v.model FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
      WHERE uv.user_id = $1 AND uv.hidden_at IS NULL ORDER BY uv.last_checked_at DESC NULLS LAST LIMIT 10`, [user.id]);
  if (!rows.length) { await doors(mobile, 'There is no vehicle in your list.'); return; }
  const out = await send.list(mobile, {
    body: '🗑 *Remove a vehicle*\n\nWhich one should come off your list? I will ask before removing it.'
      + (rows.length >= 10 ? '\n\n_For any other, send *remove* and its number — like remove KA01XX1234._' : ''),
    button: 'Choose vehicle',
    sectionTitle: 'Remove which?',
    rows: rows.map((r) => ({ id: `rm:${r.reg_no}`, title: r.reg_no, description: [r.maker, r.model].filter(Boolean).join(' ').slice(0, 60) || undefined })),
  });
  if (!out.ok) await send.text(mobile, 'Send *remove* and the vehicle number — like *remove KA01XX1234*.');
}

/*
 * THE WARNING (user: "confirm warning for user that this vehicle will be removed and
 * no more alerts will go"). Said plainly for what this vehicle has: paid monitoring
 * and its date, a report still downloadable, or only the basic check.
 */
async function removeConfirm(mobile, regNo) {
  const user = await store.upsertUser(mobile);
  const d = await require('../vehicle/remove').describe(user.id, regNo);
  if (!d) { await reply(mobile, `*${regNo}* is not in your list.`, [{ id: BTN.MY_VEHICLES, title: 'My vehicles' }, 'menu']); return; }
  const lines = [`⚠️ *Remove ${regNo} from your list?*`, ''];
  if (d.watched_until) {
    lines.push(`🔕 ${d.paid ? 'Your paid monitoring' : 'Monitoring'} for it stops now${new Date(d.watched_until) > new Date()
      ? ` (it was to run till ${dayIn(d.watched_until)})` : ''} — *no more alerts* about this vehicle: no challan alerts, expiry warnings or updates.`);
    if (d.paid) lines.push('_The remaining days are not carried over to another vehicle._');
  } else {
    lines.push('🔕 No alerts will come for it.');
  }
  if (d.report_until) lines.push('', `📄 Your report stays in *My reports* until ${dayIn(d.report_until)}, and the invoice stays too.`);
  lines.push('', 'You can check this number again any time — it comes back as a new entry.');
  await reply(mobile, lines.join('\n'),
    [{ id: `rm_yes:${regNo}`, title: 'Yes, remove' }, { id: 'rm_no', title: 'No, keep it' }]);
}

async function removeDo(mobile, regNo) {
  const user = await store.upsertUser(mobile);
  const out = await require('../vehicle/remove').removeForUser(user.id, regNo, { channel: 'whatsapp' });
  await funnel(mobile, 'vehicle_removed', { reg_no: regNo, alerts_stopped: out.alerts_stopped || 0 });
  if (!out.ok) {
    await reply(mobile, `*${regNo}* was already off your list.`, [{ id: BTN.MY_VEHICLES, title: 'My vehicles' }, 'check', 'menu']);
    return;
  }
  console.log('[wa] %s removed %s (alerts stopped: %d)', mobile, regNo, out.alerts_stopped);
  await reply(mobile, `🗑 *${regNo}* is removed from your list${out.alerts_stopped ? ', and its alerts are stopped' : ''}.\n\n`
    + 'Send the number again any time to check it.',
  [{ id: BTN.MY_VEHICLES, title: 'My vehicles' }, 'check', 'menu']);
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

/*
 * THE MENU (user, 2026-10-12: the website chat's options on WhatsApp too — email,
 * what do I get, help, terms, stop/deactivate — with Check a vehicle first, My
 * vehicles and My monitoring). WhatsApp allows ten rows, so Feedback and Fleet
 * moved: Feedback is a button after every report, Fleet one under "What do I
 * get?". With owner verification on, its row takes the GST invoice's place
 * (invoices still come by typing "invoice", and with every payment).
 */
async function mainMenu(mobile, body = 'What would you like to do?') {
  const user = await db.one(`SELECT email, email_verified_at FROM users WHERE mobile = $1`, [mobile]).catch(() => null);
  const ownerRow = await owners.enabled()
    ? { id: BTN.OWNER_VERIFY, title: 'I own a vehicle', description: 'Verify it with your RC — badge, and hide it from others' } : null;
  const out = await send.list(mobile, {
    body,
    button: 'Choose',
    sectionTitle: 'GaadiPe',
    rows: [
      { id: BTN.CHECK_ANOTHER,   title: 'Check a vehicle',  description: 'Any Indian number — basics are free' },
      { id: BTN.MY_VEHICLES,     title: 'My vehicles',      description: 'Pick one — its report, or a fresh check' },
      { id: BTN.MY_MONITORING,   title: 'My monitoring',    description: 'Watched vehicles, end dates, next alert, paused alerts' },
      { id: BTN.DOWNLOAD_REPORT, title: 'My reports',       description: 'Send my report PDF again' },
      ownerRow || { id: BTN.INVOICE, title: 'My GST invoice', description: 'The tax invoice for a payment' },
      { id: BTN.EMAIL,           title: 'Email for alerts',
        description: user?.email_verified_at ? `✓ ${user.email}` : 'Add and confirm your email for reports & alerts' },
      { id: BTN.WHAT_GET,        title: 'What do I get?',   description: 'Free check, full report, monitoring, fleets' },
      { id: BTN.SUPPORT,         title: 'Help & support',   description: 'Ask us anything · terms, privacy and refunds' },
      // In Terms & privacy's place (user, 2026-10-13: "one more option in menu: current offers").
      { id: BTN.OFFERS_NOW,      title: 'Current offers',   description: 'Prices, renewals and what is on offer today' },
      { id: BTN.STOP_MENU,       title: 'Stop / delete account', description: 'Stop messages, or delete my data' },
    ],
  });
  // A list needs an open 24-hour window; if it is shut, buttons would fail too,
  // but a plain sentence still arrives.
  if (!out.ok) await send.text(mobile, `${body}\n\nSend a vehicle number to begin.`);
  return out;
}

/* ─────────────────────────── the menu's own pages (user, 2026-10-12) ── */

const dayIn = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
// ₹19 and ₹11 stay whole; an amount with paise (₹10.62) keeps them.
const rupeesOf = (paise) => `₹${(Number(paise || 0) / 100).toFixed(Number(paise || 0) % 100 ? 2 : 0)}`;
/* " (₹9.32 + ₹1.68 GST)" — what an inclusive amount is made of, at 18% (2026-10-14: replace ₹11). */
const gstBreak = (paise) => {
  const total = Number(paise || 0);
  const taxable = Math.round(total / 1.18);
  return total ? ` (₹${(taxable / 100).toFixed(2)} + ₹${((total - taxable) / 100).toFixed(2)} GST)` : '';
};
const DOC_NAME = { insurance_upto: 'Insurance', pucc_upto: 'PUC', tax_upto: 'Road tax', fitness_upto: 'Fitness', permit_upto: 'Permit' };

/** "My monitoring": each watched vehicle as on the website's My subscriptions (site/subscriptions.js). */
async function myMonitoring(mobile) {
  const user = await store.upsertUser(mobile);
  const { rows } = await require('../site/subscriptions').forUser(user.id);
  if (!rows.length) {
    await reply(mobile, '📋 *My monitoring*\n\nNo vehicle is being monitored yet.\n\n'
      + 'Every full report includes *28 days of monitoring* — a message before insurance, PUC, road tax, fitness or permit '
      + 'expires, and when a new challan appears.', ['check', { id: BTN.WHAT_GET, title: 'What do I get?' }, 'menu']);
    return;
  }
  const blocks = rows.slice(0, 6).map((s) => {
    const lines = [`🚗 *${s.reg_no}* — ${!s.active ? (s.stopped ? 'stopped' : 'ended') : s.plan === 'paid' ? '★ paid' : '👁 free'}`];
    if (s.active) {
      lines.push(`• Ends *${dayIn(s.ends_at)}*${s.days_left != null ? ` (${s.days_left} day${s.days_left === 1 ? '' : 's'} left)` : ''}`);
      if (s.paused_until) lines.push(`• ⏸️ Alerts paused till ${dayIn(s.paused_until)}`);
      else if (s.next_alert) {
        lines.push(`• Next alert: ${dayIn(s.next_alert.date)} — ${s.next_alert.kind === 'ending'
          ? 'monitoring ends soon' : `${DOC_NAME[s.next_alert.doc] || 'a document'} expires in ${s.next_alert.days} day${s.next_alert.days === 1 ? '' : 's'}`}`);
      }
    } else if (s.stopped) {
      // Switched off or removed before its end date (user, 2026-10-13: "'Ended 24 Oct 2026'
      // doesn't make sense" — a date still ahead never "ended").
      lines.push(s.ends_at ? `• Stopped early — it was to run till ${dayIn(s.ends_at)}` : '• Stopped early');
    } else if (s.ends_at) {
      lines.push(`• Ended on ${dayIn(s.ends_at)}`);
    }
    if (s.next_document) lines.push(`• Next to expire: ${DOC_NAME[s.next_document.doc] || s.next_document.label} on ${dayIn(s.next_document.date)}`);
    if (s.renew_paise) lines.push(`• ${s.stopped ? 'Start again' : 'Renew'} for 28 days: *${rupeesOf(s.renew_paise)}* — send the vehicle number`);
    if (s.replace?.ok) {
      lines.push(`• 🔁 Replace with another vehicle: *${rupeesOf(s.replace.price_paise)}*${s.replace.until ? ` (till ${dayIn(s.replace.until)})` : ''}`);
    }
    return lines.join('\n');
  });
  const more = rows.length > 6 ? `\n\n_…and ${rows.length - 6} more on gaadipe.in._` : '';
  const paused = rows.some((s) => s.paused_until);
  /*
   * ROUTINE UPDATES ON OR OFF (user, 2026-10-12: "do we have Only alert changes?").
   * The choice (alertChoice, jobs/watch.js dailyStatus) had lost its button with the
   * old alert template; it lives here now. Read by its words, like before.
   */
  const choice = await db.one(
    `SELECT kind FROM event_log WHERE user_id = $1 AND kind IN ('watch_status_off', 'watch_status_on')
      ORDER BY created_at DESC, id DESC LIMIT 1`, [user.id]).catch(() => null);
  const quiet = choice?.kind === 'watch_status_off';
  const dailyDays = await settings.num('watch_status_daily_days', 0);
  const every = await settings.num('watch_status_every_days', 3);
  const mailEvery = await settings.num('watch_status_email_every_days', 2);
  const cadence = `every ${every === 2 ? 'other day' : `${every} days`} on WhatsApp`
    + (mailEvery !== every ? ` (every ${mailEvery === 2 ? 'other day' : `${mailEvery} days`} by email)` : '');
  const how = quiet
    ? '🔕 _Routine updates are off — you hear from us only when something changes._'
    : `🔔 _Routine updates: ${dailyDays > 0 ? `daily for the first ${dailyDays} days, then ` : ''}${cadence} — plus an alert at once whenever something changes._`;
  // Two of these, most needed first, then Menu (WhatsApp allows three buttons).
  const replaceable = rows.some((s) => s.replace?.ok);
  const firsts = [
    paused ? { id: 'mon_resume', title: 'Resume alerts' } : null,
    replaceable ? { id: 'rp_pick', title: 'Replace vehicle' } : null,
    quiet ? { id: 'status_on', title: 'Keep me updated' } : { id: 'status_off', title: 'Alert only on change' },
    { id: BTN.MY_VEHICLES, title: 'My vehicles' },
  ].filter(Boolean).slice(0, 2);
  await reply(mobile, `📋 *My monitoring*\n\n${blocks.join('\n\n')}${more}\n\n${how}`, [...firsts, 'menu']);
}

/* ─────────── REPLACE VEHICLE (user, 2026-10-13; pay/replace.js) — ₹9 + GST ── */

/** Which vehicle? One that may be replaced is asked about straight away. */
async function replacePick(mobile) {
  const user = await store.upsertUser(mobile);
  const { rows } = await require('../site/subscriptions').forUser(user.id);
  const ok = rows.filter((s) => s.replace?.ok);
  if (!ok.length) {
    await reply(mobile, '🔁 *Replace vehicle*\n\nA vehicle with paid monitoring can be replaced once, within a few days of buying its report or renewal. '
      + 'None of yours can be replaced right now.', [{ id: BTN.MY_MONITORING, title: 'My monitoring' }, 'menu']);
    return;
  }
  if (ok.length === 1) { await replaceAsk(mobile, ok[0].reg_no); return; }
  const out = await send.list(mobile, {
    body: '🔁 *Replace vehicle*\n\nWhich vehicle\'s monitoring should move to another vehicle?',
    button: 'Choose vehicle', sectionTitle: 'Replace which?',
    rows: ok.slice(0, 10).map((s) => ({ id: `rp:${s.reg_no}`, title: s.reg_no, description: `Monitoring till ${dayIn(s.ends_at)}` })),
  });
  if (!out.ok) await send.text(mobile, 'Send *replace* and the vehicle number — like *replace KA01XX1234*.');
}

/** Asks for the new vehicle's number (state replace_to). */
async function replaceAsk(mobile, fromReg) {
  const user = await store.upsertUser(mobile);
  const e = await require('../pay/replace').eligible(user.id, fromReg);
  if (!e.ok) { await reply(mobile, e.message, [{ id: BTN.MY_MONITORING, title: 'My monitoring' }, 'menu']); return; }
  await db.query(`UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1`,
    [mobile, JSON.stringify({ replace_from: fromReg, replace_to: null })]);
  await setState(mobile, 'replace_to', `replace ${fromReg}`);
  await send.text(mobile, `🔁 *Replace ${fromReg}*\n\nType the *new vehicle number* — like *KA01XX1234*.\n\n`
    + `Its monitoring moves there until *${dayIn(e.ends_on)}*, for *${rupeesOf(e.price_paise)}* (GST included). `
    + 'I will show you the vehicle before you pay.\n\n_Send *hi* to cancel._');
}

/** The new number typed: looked up, then the confirmation with Pay. */
async function replaceConfirm(mobile, toRaw) {
  const user = await store.upsertUser(mobile);
  const fromReg = (await sessionContext(mobile)).replace_from;
  if (!fromReg) { await replacePick(mobile); return; }
  await send.text(mobile, 'Checking the new vehicle … ⏳');
  const p = await require('../pay/replace').prepare(user.id, mobile, fromReg, toRaw);
  if (!p.ok) {
    await send.text(mobile, `${p.message}\n\n_Type another number, or send *hi* to cancel._`);
    return;
  }
  await db.query(`UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1`,
    [mobile, JSON.stringify({ replace_to: p.to.reg_no })]);
  await setState(mobile, 'owner_start', 'replace confirm');
  const what = [p.to.maker, p.to.model].filter(Boolean).join(' ');
  await reply(mobile, `🔁 *Replace ${fromReg} with ${p.to.reg_no}?*\n\n`
    + `🚗 *${p.to.reg_no}*${what ? ` — ${what}` : ''}\n\n`
    + `• Monitoring moves to ${p.to.reg_no} until *${dayIn(p.ends_on)}* — new challans and document expiry warnings.\n`
    + `• ${fromReg} comes off your list and its alerts stop; its report stays in My reports.\n`
    + `• The full report of ${p.to.reg_no} is not included.\n\n`
    + `Fee: *${rupeesOf(p.price_paise)}*, inclusive of GST${gstBreak(p.price_paise)}. This can be done once for this purchase.\n\n`
    + `_By paying you agree to our Terms (${SITE}/terms), Refund (${SITE}/refund) and Privacy (${SITE}/privacy) policies._`,
  [{ id: 'rp_pay', title: `Pay ${rupeesOf(p.price_paise)}` }, { id: 'rp_cancel', title: 'Cancel' }]);
}

async function replacePay(mobile) {
  const user = await store.upsertUser(mobile);
  const ctx = await sessionContext(mobile);
  if (!ctx.replace_from || !ctx.replace_to) { await replacePick(mobile); return; }
  const R = require('../pay/replace');
  const p = await R.prepare(user.id, mobile, ctx.replace_from, ctx.replace_to, { lookup: false });
  if (!p.ok) { await reply(mobile, p.message, [{ id: BTN.MY_MONITORING, title: 'My monitoring' }, 'menu']); return; }
  if (!baseUrl()) { await reply(mobile, 'Payment is not available right now. Please try again shortly.', ['support', 'menu']); return; }
  // The owner's own tries run on Razorpay test keys, as on the website (razorpay.isTestBuyer).
  const out = await R.order(user.id, mobile, p, { channel: 'whatsapp', test: await require('../pay/razorpay').isTestBuyer(user).catch(() => false) });
  if (!out.ok) { await reply(mobile, out.message, ['support', 'menu']); return; }
  await setState(mobile, 'awaiting_payment', `replace order ${out.row.order_id}`);
  await funnel(mobile, 'replace_link_sent', { reg_no: p.to.reg_no, from: p.from.reg_no, payment_row: out.row.id });
  await reply(mobile, `🔁 *${p.from.reg_no} → ${p.to.reg_no}* · ${rupeesOf(out.row.amount_paise)}\n\n`
    + `Pay securely here (UPI, card, netbanking):\n${baseUrl()}/pay/${out.row.checkout_token}\n\n`
    + 'The vehicle is replaced the moment the payment goes through.', ['support', 'menu']);
}

/** "Email for alerts": shows the confirmed address, or asks for one (then a 4-digit code, mail/emailCode.js). */
async function emailMenu(mobile, { change = false } = {}) {
  const user = await store.upsertUser(mobile);
  if (user.email && user.email_verified_at && !change) {
    await reply(mobile, `📧 *Email for alerts*\n\n*${user.email}* ✓ confirmed.\n\n`
      + 'Your reports, receipts and vehicle alerts go there too.',
    [{ id: BTN.EMAIL_CHANGE, title: 'Change email' }, { id: BTN.MY_MONITORING, title: 'My monitoring' }, 'menu']);
    return;
  }
  await setState(mobile, 'email_ask', 'asked for email');
  await send.text(mobile, '📧 *Email for alerts*\n\nType your email address — I will send a *4-digit code* to confirm it.\n\n'
    + '_Your reports, receipts and vehicle alerts will go there too. Send *hi* to cancel._');
}

async function emailCodeSent(mobile, email, out) {
  await db.query(`UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1`,
    [mobile, JSON.stringify({ email_pending: email })]);
  await setState(mobile, 'email_code', 'email code sent');
  await send.text(mobile, `✉️ I have sent a *4-digit code* to *${email}*.\n\nType it here to confirm. It is valid for 10 minutes.`
    + (out.dev ? '\n\n_(Test server: the code is in the server log, not emailed.)_' : '')
    + '\n\n_Not there? Check spam, or send *hi* to cancel._');
}

/** "What do I get?" — the offer in one message, prices from the plan. */
async function whatYouGet(mobile) {
  const plan = await billing.reportPlan().catch(() => null);
  const price = plan ? rupeesOf(plan.price_paise) : '₹19';
  const renew = plan && Number(plan.renewal_paise) > 0 ? rupeesOf(plan.renewal_paise) : null;
  const days = plan?.duration_days || 28;
  await reply(mobile, '💡 *What you get with GaadiPe*\n\n'
    + '✅ *Free check* — send any vehicle number: the vehicle, the owner’s name (masked), registration date and age, RC status, '
    + 'seats and weight, the RTO, every validity date (insurance, PUC, road tax, fitness, permit) and how many challans are pending, with the total.\n\n'
    + `📋 *Full report — ${price}* — adds the loan / hypothecation, blacklist and NOC, each challan with offence and place, number of owners, `
    + 'insurer and policy, FASTag, and what to check before you buy — as a PDF.\n\n'
    + `🔔 *${days} days of monitoring included* — a message before any document expires, and when a new challan appears.\n\n`
    + (renew ? `🔄 *Renew for ${renew}* — another ${days} days.\n\n` : '')
    + '🚛 *Fleets (5+ vehicles)* — one Excel report of every vehicle, by email, every evening.\n\n'
    + `Sample report: ${require('../mail/customer').SITE()}/sample-report.pdf`,
  ['check', { id: BTN.FLEET, title: 'Fleet (5+ vehicles)' }, 'menu']);
}

/*
 * CURRENT OFFERS (user, 2026-10-13: "one more option in menu: current offers"). Read
 * live, so it is never out of date: the admin's own line (Settings offers_text — a
 * festival offer, say), the report price with any discount, the renewal and replace
 * prices, and free reports given to this customer. Asked for, so a reply — not marketing.
 */
async function currentOffers(mobile) {
  const user = await store.upsertUser(mobile);
  const plan = await billing.reportPlan().catch(() => null);
  const replace = await db.one(`SELECT price_paise FROM plans WHERE code = 'REPLACE9' AND is_active`).catch(() => null);
  const gifts = (await require('../admin/gifts').available(user.id).catch(() => [])).length;
  const custom = String(await settings.get('offers_text', '') || '').trim();
  const renewDays = await settings.num('report_renewal_window_days', 30);
  const days = plan?.duration_days || 28;
  const lines = ['🎁 *Current offers*', ''];
  if (custom) lines.push(`🔥 ${custom}`, '');
  if (gifts) lines.push(`🎉 *You have ${gifts} free full report${gifts === 1 ? '' : 's'}* from GaadiPe — send any vehicle number to use ${gifts === 1 ? 'it' : 'one'}.`, '');
  lines.push('✅ *Basic vehicle check — free.* Send any number.');
  if (plan) {
    lines.push(plan.discount_paise
      ? `📋 *Full report — ~${rupeesOf(plan.list_price_paise)}~ ${rupeesOf(plan.price_paise)}* (${rupeesOf(plan.discount_paise)} off) — with ${days} days of alerts.`
      : `📋 *Full report — ${rupeesOf(plan.price_paise)}* — with ${days} days of alerts included.`);
    if (Number(plan.renewal_paise) > 0) {
      lines.push(`🔄 *Renew for ${rupeesOf(plan.renewal_paise)}* — the same vehicle${renewDays > 0 ? ` within ${renewDays} days of its last report` : ''}.`);
    }
  }
  if (replace) lines.push(`🔁 *Changed your vehicle?* Move your monitoring to it for ${rupeesOf(replace.price_paise)}, GST included.`);
  await reply(mobile, lines.join('\n'), ['check', { id: BTN.MY_MONITORING, title: 'My monitoring' }, 'menu']);
}

async function termsAndPrivacy(mobile) {
  const site = require('../mail/customer').SITE();
  await reply(mobile, '📜 *Terms & privacy*\n\n'
    + `Terms of use: ${site}/terms\n`
    + `Privacy policy: ${site}/privacy\n`
    + `Refunds: ${site}/refund\n\n`
    + 'Personal details from the Government record are masked in every report. '
    + 'You can stop messages or ask us to delete your data any time from the menu.',
  [{ id: BTN.SUPPORT, title: 'Help & support' }, 'menu']);
}

/** "Stop / delete account": asked, never done on the first tap. */
async function stopMenu(mobile) {
  await reply(mobile, '⚙️ *Stop / delete account*\n\n'
    + '*Stop messages* — GaadiPe will not message you unless you write first. Reply *START* any time to undo.\n\n'
    + '*Delete my data* — we delete your name, chats, feedback and the vehicles you checked. '
    + 'Payment records and GST invoices are kept for the period the law requires.',
  [{ id: BTN.STOP_CONFIRM, title: 'Stop messages' }, { id: BTN.DELETE_DATA, title: 'Delete my data' },
   { id: BTN.STOP_CANCEL, title: 'Keep everything' }]);
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

/*
 * EACH STEP IN PLAIN WORDS (user, 2026-10-14: "a good log, understandable, for all
 * activities" in pm2 logs). One [activity] line per step, next to the website's and
 * the admin's (util/activity.js). d is the step's detail.
 */
const MENU_WORDS = { menu_my_vehicles: 'My vehicles', menu_my_monitoring: 'My monitoring', menu_email: 'Email for alerts',
  menu_what_get: 'What do I get?', menu_terms: 'Terms & privacy', menu_offers: 'Current offers', menu_stop: 'Stop / delete account' };
const STEP_WORDS = {
  hi: () => ['👋', 'Said Hi on WhatsApp'],
  agreed: (d) => ['✅', d.offers ? 'Agreed to the Terms + news & offers' : 'Agreed to the Terms (no offers)'],
  offers_answer: (d) => [d.offers ? '🎁' : '🙅', d.offers ? 'Said yes to tips & offers' : 'Said no to tips & offers'],
  number: (d) => ['🔢', `Sent a vehicle number · ${d.reg_no}`],
  basic_shown: (d) => ['🔍', `Vehicle checked · ${d.reg_no} · found${d.bought ? ' · already has its full report' : ''}`],
  lookup_failed: (d) => ['⚠️', `Vehicle check failed · ${d.reg_no} · ${d.reason === 'not_found' ? 'not in Government records' : 'records service error'}`],
  vehicle_private: (d) => ['🔒', `Vehicle check · ${d.reg_no} · its owner made it private`],
  buy_now_offered: (d) => ['💡', `Was offered the full report · ${d.reg_no}`],
  buy_tapped: (d) => ['🛒', `Tapped "Get full report" · ${d.reg_no}`],
  gift_used: (d) => ['🎁', `Used a free report · ${d.reg_no}${d.left != null ? ` · ${d.left} left` : ''}`],
  link_sent: (d) => ['💳', `Payment link sent · ${d.reg_no}`],
  replace_link_sent: (d) => ['💳', `Replace-vehicle payment link sent · ${d.from} → ${d.reg_no}`],
  vehicle_removed: (d) => ['🗑', `Removed ${d.reg_no} from My vehicles${d.alerts_stopped ? ' · alerts stopped' : ''}`],
  remove_pick: () => ['📋', 'Opened "Remove vehicle"'],
  replace_pick: () => ['📋', 'Opened "Replace vehicle"'],
  watch_status_off: () => ['🔕', 'Turned routine monitoring updates off'],
  watch_status_on: () => ['🔔', 'Turned routine monitoring updates on'],
  opt_out: (d) => ['🛑', `Sent STOP — no more messages${d.from === 'menu' ? ' (from the menu)' : ''}`],
  opt_out_reason: (d) => ['🛑', `Why STOP: ${d.reason}${d.said ? ` — “${d.said}”` : ''}`],
  opt_in: (d) => ['▶️', d.undo ? 'Undid STOP' : 'Came back (START)'],
  data_delete_request: () => ['🗑', 'Asked to delete their account & data'],
  email_confirmed: () => ['📧', 'Confirmed their email'],
  owner_verify_started: (d) => ['🪪', `Started owner verification · ${d.reg_no}`],
  owner_photo_sent: (d) => ['🪪', `Sent an RC photo · ${d.reg_no}`],
  owner_verified: (d) => ['🪪', `Verified as owner · ${d.reg_no}`],
  owner_verify_failed: (d) => ['🪪', `Owner verification failed · ${d.reg_no}${d.locked ? ' · locked' : ''}`],
  alert_thanks: () => ['🙏', 'Tapped "Thanks" on a monitoring alert'],
  alert_check: (d) => ['🔍', `Tapped "Check vehicle" on a monitoring alert${d.reg_no ? ` · ${d.reg_no}` : ''}`],
  alert_pause_asked: () => ['⏸', 'Tapped "Pause this alert" — asked to confirm'],
  alert_paused: () => ['⏸', 'Paused a vehicle\'s alerts for 30 days'],
  alert_pause_cancelled: () => ['▶️', 'Kept alerts on (did not pause)'],
  alert_resumed: () => ['▶️', 'Resumed alerts'],
  email_later: () => ['📧', 'Said "Not now" to adding an email'],
  renewal_renew: (d) => ['🔄', `Tapped "Renew now" on the renewal reminder${d.reg_no ? ` · ${d.reg_no}` : ''}`],
  renewal_monitoring: () => ['📋', 'Tapped "My monitoring" on the renewal reminder'],
  renewal_not_now: (d) => ['🙅', `Tapped "Not now" on the renewal reminder${d.reg_no ? ` · ${d.reg_no}` : ''}`],
};
function stepWords(step, d) {
  if (STEP_WORDS[step]) return STEP_WORDS[step](d);
  if (MENU_WORDS[step]) return ['📋', `Opened menu: ${MENU_WORDS[step]}`];
  return ['•', step.replace(/_/g, ' ')];
}

async function funnel(mobile, step, detail = {}) {
  try {
    const act = require('../util/activity');
    const [icon, words] = stepWords(step, detail);
    act.whoOf(mobile).then((who) => act.log(icon, words, { who, detail: 'WhatsApp' })).catch(() => {});
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
  + ' You also agree to receive messages about your account, checks and reports on WhatsApp, SMS or email — the same account works on gaadipe.in.'
  // The offers opt-in, in the same message (user, 2026-10-09: "no separate step"), as its own button.
  + '\n\nTap *Agree, news & offers* to also get our newsletter and occasional offers here — at most one a week; reply STOP any time.';

/*
 * AGREE, OR AGREE + OFFERS (user, 2026-10-09). One message, two buttons: the
 * Terms alone, or the Terms and the tips-&-offers opt-in in one tap. Marketing
 * stays a real, separate choice (DPDP; the promise in the Meta appeal) without
 * a separate step. WhatsApp allows 20 characters per button.
 * Swapped and renamed (user, 2026-10-13: "swap the buttons; replace 'get offers'
 * with 'get newsletter & offers'") — "Agree, news & offers" is that, in 20.
 */
const AGREE_BUTTONS = () => [
  { id: BTN.AGREE_OWNER_OFFERS, title: 'Agree, news & offers' },
  { id: BTN.AGREE_OWNER, title: 'Agree & continue' },
];
// The exact words recorded with the opt-in (site/auth.setPromoConsent).
const AGREE_OFFERS_WORDS = 'Agree, news & offers — I agree to the Terms, Privacy and Refund policies, and to receive the GaadiPe newsletter and occasional offers on WhatsApp (at most one a week; STOP any time).';

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
    await reply(mobile,
      'You do not have any invoices yet — they are issued when a payment is made.', ['check', 'reports', 'menu']);
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
    await reply(mobile,
      'You do not have any reports yet.\n\n'
      + 'Send me a vehicle number — after the basic check you can get the full report.', ['check', 'menu']);
    return;
  }

  const now = new Date();
  const live = rows.filter(r => (r.valid_until
    ? new Date(r.valid_until) > now
    : r.is_active && r.ends_on && new Date(r.ends_on) >= now));

  for (const r of live) {
    if (r.valid_until) {
      await sendValidReport(mobile, r, { next: false });   // the buttons once, after the last
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

  if (live.length) await afterReport(mobile, live.length === 1 ? live[0].reg_no : null);

  if (!live.length) {
    const reg = rows[0].reg_no;
    await db.query(
      `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now()
        WHERE mobile = $1`, [mobile, JSON.stringify({ pending_reg: reg })]);
    await setState(mobile, 'owner_start', 'reports lapsed');
    await send.buttons(mobile,
      `Your report for *${reg}* can no longer be downloaded — its download period has ended.\n\n`
      + 'Send the vehicle number again to check today\'s records.',
      [{ id: BTN.CHECK_ANOTHER, title: 'Check a vehicle' },
       { id: BTN.FEEDBACK,      title: 'Feedback' },
       { id: BTN.MENU,          title: 'Menu' }]);
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
    await reply(mobile,
      '📸 *Got it — thank you!* 🙏\n\n'
      + `Your RC for *${r.regNo}* is now *being checked*. You will get a message here as soon as it is done — usually within a few hours.\n\n`
      + '🔒 It is kept locked, seen only by GaadiPe, and *deleted as soon as it is checked*.\n\n'
      + 'Meanwhile, you can send any vehicle number to check it.', ['check', 'reports', 'menu']);
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
    await reply(mobile, `🔒 The owner of *${regNo}* keeps its details private, so GaadiPe cannot show them.\n\n`
      + 'If this vehicle is yours, write to support@gaadipe.in. You can send another vehicle number any time.',
    ['other', 'support', 'menu']);
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
      await reply(mobile, `I could not find any Government record for *${regNo}*.\n\n`
        + 'Please check the number and send it again. Very new vehicles can take '
        + 'a few weeks to appear.', ['other', 'support', 'menu']);
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
      [{ id: BTN.BUY_REPORT, title: `Full report ₹${Math.round(plan.price_paise / 100)}` },
       NEXT.other, NEXT.menu]);
      return;
    }
    await reply(mobile, downText, ['other', 'reports', 'menu']);
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
  // 'public' (2026-10-14): the website's signed-in view — Agree is the sign-in on WhatsApp.
  const freeDetail = String(await settings.get('whatsapp_free_view_detail', 'count')).toLowerCase();
  const price = plan ? `₹${Math.round(plan.price_paise / 100)}` : undefined;
  await send.text(mobile, badge + (watched ? `${watched}\n\n` : '') + (bought
    ? await report.buildFor(data, { detailed: true })
    : freeDetail === 'public' ? await report.publicText(data, price ? { price } : {})
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
  // The email tip after a check (2026-10-15) — once, for someone without a confirmed email.
  await emailNudge(mobile, 'check');
  // (The separate tips-&-offers question is gone, 2026-10-09: it is the second Agree button now.)
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
    AGREE_BUTTONS(),
    { footer: 'ServerPe App Solutions' });
  await setState(mobile, 'owner_consent', 'terms shown');
}

/*
 * NEVER A DEAD END (user, 2026-10-12: "if report present you reply with report but
 * always make sure to keep at least 2 or 3 reply buttons to keep engaging"). After
 * a report is handed over, three ways on. Reply buttons need the 24-hour window,
 * which a tap or a message has just opened; shut, they are simply not sent.
 */
async function afterReport(mobile, regNo) {
  await send.buttons(mobile,
    `${regNo ? `✅ That is your full report for *${regNo}*.` : '✅ Those are your reports.'} What would you like to do next?`,
    [{ id: BTN.CHECK_ANOTHER, title: 'Check other vehicle' },
     { id: BTN.FEEDBACK,      title: 'Feedback' },
     { id: BTN.MENU,          title: 'Menu' }]).catch(() => {});
}

/*
 * THE RENEWAL REMINDER'S BUTTONS (user, 2026-10-14: "we need repliable buttons to make our
 * reply rating higher"). gp_renewal_en_v1 carries three quick replies, in this order, whose
 * payloads jobs/renewal.js sets to ren|<action>|<vehicle number>:
 *   r  "Renew now"      the vehicle opens, as if its number were sent: the report it
 *                       had has lapsed by then (report_valid_days), so the check shows
 *                       with the renewal price on the buy button (billing.reportPriceFor)
 *   m  "My monitoring"  every vehicle being watched and when it ends
 *   n  "Not now"        a thank-you, and that nothing is charged
 * A tap whose payload was lost arrives with the button's words; those are matched too —
 * never the bot's own buttons, which carry ids of their own.
 */
const RENEW_TAP = { r: /^renew( now)?$/i, m: /^my monitoring$/i, n: /^not now$/i };
const RENEW_STEP = { r: 'renewal_renew', m: 'renewal_monitoring', n: 'renewal_not_now' };
async function renewalTap(mobile, intent, message) {
  if (intent.kind !== 'button') return false;
  const hit = /^ren\|([rmn])\|([A-Z0-9]{4,12})$/.exec(String(intent.id || ''));
  const lost = !intent.id || intent.id === intent.text;
  const action = hit?.[1] || (lost && Object.keys(RENEW_TAP).find((k) => RENEW_TAP[k].test(String(intent.text || '').trim())));
  if (!action) return false;
  const reg = hit?.[2] || null;
  await funnel(mobile, RENEW_STEP[action], reg ? { reg_no: reg } : {});
  if (action === 'r' && reg) { await openVehicle(mobile, reg, message, 'renewal button'); return true; }
  if (action !== 'n') { await myMonitoring(mobile); return true; }
  await reply(mobile, `👍 No problem.${reg ? ` Monitoring for *${reg}* simply ends on its date` : ' Monitoring simply ends on its date'} — nothing is charged.\n\n`
    + 'You can renew any time later: just send the vehicle number here.', ['check', 'menu']);
  return true;
}

/*
 * ADD YOUR EMAIL, ASKED BY THE BOT (user, 2026-10-15: "instead of me manually asking them" —
 * 2 of 211 customers had a confirmed email, so a WhatsApp outage cut alerts off). Only as a
 * reply to something the customer just did, so inside their window, never a broadcast:
 *   'report'  right after a paid report reaches them (routes/payments.js)
 *   'check'   after a vehicle check
 * Asked at most twice: once, and once more 30 days after a "Not now" (or no answer). Never to
 * someone with a confirmed email, someone who said STOP, or mid-way through another step.
 * Each ask is an event_log 'email_nudge'; "Not now" is 'email_nudge_later'.
 */
const EMAIL_LATER = BTN.EMAIL_LATER;
async function emailNudge(mobile, at = 'check') {
  try {
    const u = await db.one(
      `SELECT u.id, u.email_verified_at, s.wa_opt_out_at, s.state FROM users u
         LEFT JOIN whatsapp_sessions s ON s.mobile = u.mobile WHERE u.mobile = $1`, [mobile]);
    if (!u || u.email_verified_at || u.wa_opt_out_at) return false;
    if (/^(email_|replace_|rp_|rm_|stop|feedback|owner_verify)/.test(String(u.state || ''))) return false;
    const asked = await db.one(
      `SELECT count(*)::int AS n, max(created_at) AS last FROM event_log WHERE user_id = $1 AND kind = 'email_nudge'`, [u.id]);
    if (asked.n >= 2) return false;
    if (asked.n === 1 && new Date(asked.last) > new Date(Date.now() - 30 * 864e5)) return false;
    const out = await send.buttons(mobile,
      (at === 'report'
        ? '📧 *One more thing* — add your email so your alerts for this vehicle also reach you by email, '
        : '📧 *Tip* — add your email so your vehicle alerts also reach you by email, ')
      + 'even if WhatsApp is ever unavailable. It takes a minute: we send a 4-digit code to confirm it.',
      [{ id: BTN.EMAIL, title: 'Add email' }, { id: EMAIL_LATER, title: 'Not now' }]).catch(() => ({ ok: false }));
    if (!out?.ok) return false;
    await db.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'email_nudge', $2)`,
      [u.id, JSON.stringify({ mobile, at })]);
    return true;
  } catch (e) {
    console.error('[wa] email nudge for %s: %s', mobile, e.message);
    return false;
  }
}

/** Send a still-valid report: the PDF, and a link that works until it lapses — then the next steps. */
async function sendValidReport(mobile, r, { next = true } = {}) {
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
  if (next) await afterReport(mobile, r.reg_no);
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
  // STOP withdraws the tips & offers opt-in too, on every channel (the Terms say so; 2026-10-09).
  const who = await db.one(`SELECT id FROM users WHERE right(mobile, 10) = right($1, 10) AND promo_consent_at IS NOT NULL`, [mobile]).catch(() => null);
  if (who) await require('../site/auth').setPromoConsent(who.id, false, { channel: 'whatsapp' }).catch(() => {});
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

/*
 * HOW OFTEN THEY HEAR FROM US (user, 2026-10-09; the buttons on
 * gp_monitoring_alert_en_v2, tapped or typed):
 *   "Only alert changes"  no more "today's update" all-clear (jobs/watch.js
 *                         dailyStatus); real alerts — a change, an expiry,
 *                         challans — still come, as paid for
 *   "Keep me updated"     the opt-in: updates on again
 * Recorded with the time in event_log (the latest one counts). Either tap opens
 * the 24-hour window, so the answers here are free messages.
 */
async function alertChoice(mobile, text, message) {
  // "Alert only on change" is the button (20 characters, WhatsApp's limit); close wordings typed by hand count too.
  const off = /^(alert|notify)( me)? only (on|if|when)( there are| it)? changes?$|^only alert (on )?changes?$|^(alert|notify)( me)? (on|when) changes? only$|^only (on )?changes?$/i.test(String(text || '').trim());
  const on = /^(yes,? )?keep me updated$/i.test(text || '');
  if (!off && !on) return false;
  const u = await store.upsertUser(mobile);
  await db.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, $2, $3)`,
    [u.id, off ? 'watch_status_off' : 'watch_status_on', JSON.stringify({ mobile, text, at: new Date().toISOString() })]);
  await funnel(mobile, off ? 'watch_status_off' : 'watch_status_on');
  if (off) {
    // "Keep me updated" is read by its words (alertChoice), so the button needs no id of its own.
    await reply(mobile, '👍 Done. No more routine updates — I will message you *only when something changes* '
      + 'on your vehicle: a new challan, or a document about to expire.\n\n'
      + '_Changed your mind? Tap *Keep me updated*._',
    [{ id: 'keep_updated', title: 'Keep me updated' }, 'check', 'menu']);
  } else {
    await send.text(mobile, '✅ You are set — I will keep you updated on your vehicle here.');
    await myVehicles(mobile, message);
  }
  return true;
}

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
   *
   * Never from a tap on the bot's own buttons (2026-10-12): the menu row "Stop /
   * delete account" only opens the choice, and "Delete my data" there has its own
   * case below — words matched on a title would skip the question.
   */
  const ownTap = intent.kind === 'button' && Object.values(BTN).includes(intent.id);
  if (!ownTap && /\b(delete|remove|erase|wipe|clear)\b[\w\s']{0,25}\b(data|details|information|info|account|records?)\b|\bdata\s+(delete|hatao|mitao|remove)\b/i.test(intent.text || '')) {
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

  // "Stop alerts" / "Stop reminders" / "Stop offers" — the templates' own buttons (2026-10-09) — are STOP.
  if (/^(stop|unsubscribe|stop promotions|stop alerts?|stop reminders?|stop offers)\s*$/i.test(intent.text)) {
    await db.query(
      `UPDATE whatsapp_sessions SET wa_opt_out_at = now(), modified_at = now()
        WHERE mobile = $1`, [mobile]);
    await funnel(mobile, 'opt_out');
    console.log('[wa] %s replied STOP — no more messages from us', mobile);
    await stopped(mobile, 'Done ✅ — GaadiPe will not message you any more.');
    return;
  }
  // The renewal reminder's buttons — "Renew now", "My monitoring", "Not now" (2026-10-14).
  if (await renewalTap(mobile, intent, message)) return;
  // The monitoring alert's buttons — "Thanks for remembering", "Check vehicle",
  // "Pause this alert" — and "Resume alerts" (2026-10-12, monitorAlert.js).
  const tapped =await require('./monitorAlert').handleTap(mobile, intent)
    .catch((e) => { console.error('[wa] alert button for %s: %s', mobile, e.message); return null; });
  if (tapped) {
    await funnel(mobile, tapped.step, tapped.open && tapped.open !== 'list' ? { reg_no: tapped.open } : {});
    if (tapped.open === 'list') await myVehicles(mobile, message);
    else if (tapped.open) await openVehicle(mobile, tapped.open, message, 'alert button');
    return;
  }
  // The alert template's "Only alert changes" / "Keep me updated" — tapped or typed.
  if (await alertChoice(mobile, intent.text, message)) return;
  /*
   * "DON'T MESSAGE ME" IS STOP TOO (user, 2026-09-30). Someone wrote "Don't
   * message me" after seeing the price; the bot read it as a vehicle number and
   * the payment reminder went out anyway, which is what made them reply STOP.
   * Plain-language refusals — English, Hindi and Hinglish — now opt out at once.
   */
  // (Not while they are typing why they said STOP — "stop messaging me" is then the reason.)
  if (state !== 'stop_reason' && !ownTap && OPT_OUT_RE.test(intent.text || '')) {
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

    // Remove a vehicle (2026-10-13): pick → the warning → Yes, remove / No, keep it.
    if (intent.id === 'rm_pick') { await funnel(mobile, 'remove_pick'); await removePick(mobile); return; }
    if (String(intent.id || '').startsWith('rm:')) { await removeConfirm(mobile, intent.id.slice(3)); return; }
    if (String(intent.id || '').startsWith('rm_yes:')) { await removeDo(mobile, intent.id.slice(7)); return; }
    // Replace vehicle (2026-10-13): pick → new number → confirmation → Pay.
    if (intent.id === 'rp_pick') { await funnel(mobile, 'replace_pick'); await replacePick(mobile); return; }
    if (String(intent.id || '').startsWith('rp:')) { await replaceAsk(mobile, intent.id.slice(3)); return; }
    if (intent.id === 'rp_pay') { await replacePay(mobile); return; }
    if (intent.id === 'rp_cancel') {
      await setState(mobile, 'owner_start', 'replace cancelled');
      await reply(mobile, '👍 Nothing changed — your monitoring stays as it is.', [{ id: BTN.MY_MONITORING, title: 'My monitoring' }, 'check', 'menu']);
      return;
    }
    if (intent.id === 'rm_no') {
      await reply(mobile, '👍 Kept — nothing changed.', [{ id: BTN.MY_VEHICLES, title: 'My vehicles' }, 'check', 'menu']);
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
      if (/^my (vehicle )?reports?$|^my vehicles?$|^view my vehicles?$/i.test(intent.text)) { await myVehicles(mobile, message); return; }
      // The service-update template's buttons (gp_service_update_v1, 2026-10-09).
      if (/^check (another|a)( vehicle)?$/i.test(intent.text)) {
        if (!(await send.agreedTerms(mobile))) { await start(mobile); return; }
        await setState(mobile, 'owner_start', 'template: check another');
        await send.text(mobile, 'Sure — send me the vehicle number, like *KA01XX1234*.');
        return;
      }
      if (/^(support|help|contact( us)?)$/i.test(intent.text)) { await sendSupportLink(mobile); return; }
    }

    switch (intent.id) {
      case BTN.OWNER:
        await setState(mobile, 'owner_consent', 'chose owner');
        await send.buttons(mobile, OWNER_TERMS, AGREE_BUTTONS());
        return;

      case BTN.PARTNER:
        await setState(mobile, 'partner_consent', 'chose partner');
        await send.buttons(mobile, PARTNER_TERMS,
          [{ id: BTN.AGREE_PARTNER, title: 'Agree & continue' }]);
        return;

      case BTN.AGREE_OWNER_OFFERS: {
        // The Terms AND the tips-&-offers opt-in, in one tap, recorded with the words shown.
        const u = await store.upsertUser(mobile);
        await require('../site/auth').setPromoConsent(u.id, true, { channel: 'whatsapp', text: AGREE_OFFERS_WORDS })
          .catch((e) => console.error('[wa] offers opt-in:', e.message));
        await db.query(
          `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1`,
          [mobile, JSON.stringify({ offers_answer: 'yes', offers_answered_at: new Date().toISOString() })]);
      }
      // falls through: the Terms are agreed exactly as with "Agree & continue"
      case BTN.AGREE_OWNER:
        await recordConsent(mobile, 'owner', ['terms', 'privacy', 'refund']);
        // offers: which button — the admin's "agreed" email says so (jobs/notify.js waAgreed).
        await funnel(mobile, 'agreed', { offers: intent.id === BTN.AGREE_OWNER_OFFERS });
        await setState(mobile, 'owner_start', 'consent given');
        await doors(mobile,
          'Thank you. ✅\n\n'
          + 'What would you like to do?\n\n'
          + '_To check a vehicle you can also just send its number, like *KA01XX1234*._');
        return;

      case BTN.OFFERS_YES:
      case BTN.OFFERS_NO: {
        const yes = intent.id === BTN.OFFERS_YES;
        const u = await store.upsertUser(mobile);
        if (yes) await require('../site/auth').setPromoConsent(u.id, true, { channel: 'whatsapp', text: OFFERS_WORDS });
        await db.query(
          `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1`,
          [mobile, JSON.stringify({ offers_answer: yes ? 'yes' : 'no', offers_answered_at: new Date().toISOString() })]);
        await funnel(mobile, 'offers_answer', { offers: yes });
        await reply(mobile, yes
          ? '✅ Thank you — you will get occasional tips & offers here, at most one a week. Reply *STOP* any time to stop them.'
          : '👍 No problem — no offers. You will still get your reports and the alerts you asked for.',
        ['check', 'reports', 'menu']);
        return;
      }

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
          await reply(mobile,
            'You are already watching every vehicle you have checked.\n\n'
            + 'Send me another vehicle number to check it first.', ['other', 'reports', 'menu']);
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
          await reply(mobile,
            'You are not watching any vehicle yet.\n\n'
            + 'Send me a vehicle number and I will check it for you.', ['check', 'menu']);
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
          await reply(mobile,
            'Payment is not available right now. Please try again shortly.', ['support', 'menu']);
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
        // The owner's own tries in test mode, as for reports (2026-10-13).
        const test = await razorpay.isTestBuyer(user).catch(() => false);
        let order;
        try {
          order = await razorpay.createOrder({
            amountPaise: paise,
            receipt: `gp-${row.id}`,
            notes: { reg_no: vehicle.reg_no, mobile, kind, payment_row: String(row.id), ...(test ? { test_mode: 'owner' } : {}) },
            test,
          });
        } catch (e) {
          console.error('[pay] order creation failed:', e.message);
          await reply(mobile,
            'Sorry, I could not start the payment just now. Please try again in a minute.', ['support', 'menu']);
          return;
        }

        const token = require('crypto').randomBytes(16).toString('hex');
        await db.query(
          `UPDATE payments SET order_id = $2, checkout_token = $3,
                  raw = COALESCE(raw,'{}'::jsonb) || $4::jsonb WHERE id = $1`,
          [row.id, order.id, token, JSON.stringify({ order_id: order.id, ...(test ? { test_mode: true } : {}) })]);

        const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
        if (!base) {
          console.error('[pay] PUBLIC_BASE_URL is not set — cannot host a checkout page');
          await reply(mobile, 'Payment is not available right now. Please try again shortly.', ['support', 'menu']);
          return;
        }

        await setState(mobile, 'awaiting_payment', `order ${order.id}`);
        await reply(mobile,
          `*${vehicle.reg_no}* — ₹${Math.round(paise / 100)} for ${plan.duration_days} days\n\n`
          + `Review and pay here:\n${base}/pay/${token}\n\n`
          + 'You will come straight back here, and I will confirm the moment the '
          + 'payment goes through.\n\n'
          + '_One vehicle per payment for now. To add another, just send me its '
          + 'number — I will send a separate link._', ['support', 'other']);
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
            await reply(mobile, g.left
              ? `🎁 That was a free report from GaadiPe — you have *${g.left}* more to use. Send any vehicle number to use the next one.`
              : '🎁 That was your last free report from GaadiPe. Thank you for being with us! 🙏',
            ['other', { id: BTN.FEEDBACK, title: 'Feedback' }, 'menu']);
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
          await reply(mobile, 'Payment is not available right now. Please try again shortly.', ['support', 'menu']);
          return;
        }

        /* THE OWNER PAYS IN TEST MODE (user, 2026-10-13: "for both WhatsApp & web, as
           admin (me), use test mode for transactions") — Razorpay test keys, booked
           at ₹0, as on the website (razorpay.isTestBuyer: pay_test_mobiles + internal). */
        const test = await razorpay.isTestBuyer(user).catch(() => false);

        // A tap twice on the same button reuses the unpaid order rather than
        // opening a second one that could be paid as well.
        let row = await db.one(
          `SELECT * FROM payments
            WHERE user_id = $1 AND plan_id = $2 AND status = 'created'
              AND checkout_token IS NOT NULL
              AND (raw->>'vehicle_id')::bigint = $3
              AND coalesce((raw->>'test_mode')::boolean, false) = $4
              AND created_at > now() - interval '1 hour'
            ORDER BY id DESC LIMIT 1`, [user.id, plan.id, vehicle.id, test]);

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
                       mobile, plan: plan.code, ...(test ? { test_mode: 'owner' } : {}) },
              test,
            });
            if (!order?.id) throw new Error('no order id returned');
          } catch (e) {
            console.error('[pay] order creation failed:', e.message);
            await reply(mobile,
              'Sorry, I could not start the payment just now. Please try again in a minute.', ['support', 'menu']);
            return;
          }

          const token = require('crypto').randomBytes(16).toString('hex');
          row = (await db.query(
            `UPDATE payments SET order_id = $2, checkout_token = $3,
                    raw = COALESCE(raw,'{}'::jsonb) || $4::jsonb
              WHERE id = $1 RETURNING *`,
            [pending.id, order.id, token, JSON.stringify({ order_id: order.id, ...(test ? { test_mode: true } : {}) })])).rows[0];
          if (test) console.log('[pay] TEST-mode order %s for the owner on WhatsApp (payment row %d)', order.id, pending.id);
        }

        await setState(mobile, 'awaiting_payment', `order ${row.order_id}`);
        await funnel(mobile, 'link_sent', { reg_no: vehicle.reg_no, payment_row: row.id });
        // The link stays the message; Support and Other vehicle sit under it (2026-10-12).
        await reply(mobile,
          `*${vehicle.reg_no}* — full report · ₹${Math.round(row.amount_paise / 100)}\n\n`
          + `Pay securely here (UPI, card, netbanking):\n${baseUrl()}/pay/${row.checkout_token}\n\n`
          + 'The report arrives in this chat the moment the payment goes through.', ['support', 'other']);
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

      /* The menu's own pages (user, 2026-10-12). */
      case BTN.MY_VEHICLES:
        await funnel(mobile, 'menu_my_vehicles');
        await myVehicles(mobile, message);
        return;

      case BTN.MY_MONITORING:
        await funnel(mobile, 'menu_my_monitoring');
        await myMonitoring(mobile);
        return;

      // "Not now" on the email tip (2026-10-15, emailNudge): asked once more in 30 days at most.
      case EMAIL_LATER: {
        const u = await store.upsertUser(mobile);
        await db.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'email_nudge_later', $2)`,
          [u.id, JSON.stringify({ mobile })]).catch(() => {});
        await funnel(mobile, 'email_later');
        await reply(mobile, '👍 No problem. You can add it any time from *Menu → Email for alerts*.', ['check', 'menu']);
        return;
      }

      case BTN.EMAIL:
      case BTN.EMAIL_CHANGE:
        await funnel(mobile, 'menu_email', { change: intent.id === BTN.EMAIL_CHANGE });
        await emailMenu(mobile, { change: intent.id === BTN.EMAIL_CHANGE });
        return;

      case BTN.EMAIL_RESEND: {
        const user = await store.upsertUser(mobile);
        const email = (await sessionContext(mobile)).email_pending;
        if (!email) { await emailMenu(mobile, { change: true }); return; }
        const out = await require('../mail/emailCode').sendCode(user.id, email);
        if (out.ok) await emailCodeSent(mobile, email, out);
        else await reply(mobile, out.message, [{ id: BTN.EMAIL_RESEND, title: 'Send new code' }, 'menu']);
        return;
      }

      case BTN.WHAT_GET:
        await funnel(mobile, 'menu_what_get');
        await whatYouGet(mobile);
        return;

      case BTN.TERMS:
        await funnel(mobile, 'menu_terms');
        await termsAndPrivacy(mobile);
        return;

      case BTN.OFFERS_NOW:
        await funnel(mobile, 'menu_offers');
        await currentOffers(mobile);
        return;

      case BTN.STOP_MENU:
        await funnel(mobile, 'menu_stop');
        await stopMenu(mobile);
        return;

      // Its words ("Stop messages") are read as STOP above already; the id is the same thing.
      case BTN.STOP_CONFIRM:
        await db.query(`UPDATE whatsapp_sessions SET wa_opt_out_at = now(), modified_at = now() WHERE mobile = $1`, [mobile]);
        await funnel(mobile, 'opt_out', { from: 'menu' });
        console.log('[wa] %s chose Stop messages in the menu', mobile);
        await stopped(mobile, 'Done ✅ — GaadiPe will not message you any more.');
        return;

      // Its words ("Delete my data") start the deletion request above already; the same here.
      case BTN.DELETE_DATA: {
        const user = await store.upsertUser(mobile).catch(() => null);
        const r = await require('../admin/dataRequests').request({ mobile, userId: user?.id, said: 'Delete my data (menu)' });
        await funnel(mobile, 'data_delete_request', { created: r.created, from: 'menu' });
        await send.text(mobile, r.created
          ? '✅ Your request to delete your personal data is received.\n\n'
            + 'We will delete your name, chats, feedback and the vehicles you checked, and confirm it here. '
            + 'Payment records and GST invoices are kept for the period the law requires.'
          : 'Your request to delete your personal data is already with us — we will confirm here once it is done. 🙏');
        return;
      }

      case BTN.STOP_CANCEL:
        await doors(mobile, '👍 Nothing changed — you will keep getting your reports and alerts.');
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
  // "remove KA01AB1234" typed (2026-10-13) — the same warning as the list's Remove.
  const rmTyped = /^(remove|delete)\s+(?:vehicle\s+)?([a-z0-9 -]{5,15})\s*$/i.exec(intent.text || '');
  if (rmTyped && await send.agreedTerms(mobile)) {
    const parsed = plate.parse(rmTyped[2]);
    if (parsed.ok) { await removeConfirm(mobile, parsed.regNo); return; }
  }
  if (/^(remove|delete)( a)?( vehicle)?\s*$/i.test(intent.text || '') && await send.agreedTerms(mobile)) {
    await removePick(mobile);
    return;
  }
  // "replace KA01AB1234" / "replace vehicle" typed (2026-10-13).
  const rpTyped = /^replace\s+(?:vehicle\s+)?([a-z0-9 -]{5,15})\s*$/i.exec(intent.text || '');
  if (rpTyped && state !== 'replace_to' && await send.agreedTerms(mobile)) {
    const parsed = plate.parse(rpTyped[1]);
    if (parsed.ok) { await replaceAsk(mobile, parsed.regNo); return; }
  }
  if (/^replace( a| my)?( vehicle)?\s*$/i.test(intent.text || '') && await send.agreedTerms(mobile)) {
    await replacePick(mobile);
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

    // Replace vehicle (2026-10-13): whatever is typed now is the new vehicle's number.
    case 'replace_to':
      await replaceConfirm(mobile, intent.text || '');
      return;

    // "Email for alerts" from the menu (2026-10-12): the address, then its 4-digit code.
    case 'email_ask': {
      const user = await store.upsertUser(mobile);
      const email = String(intent.text || '').trim().toLowerCase();
      const out = await require('../mail/emailCode').sendCode(user.id, email);
      if (out.ok) { await emailCodeSent(mobile, email, out); return; }
      await send.text(mobile, `${out.message}${out.suggestion ? `\n\nDid you mean *${out.suggestion}*?` : ''}\n\n`
        + '_Type your email address again, or send *hi* to cancel._');
      return;
    }

    case 'email_code': {
      const code = String(intent.text || '').replace(/\s/g, '');
      if (!/^\d{4}$/.test(code)) {
        await send.text(mobile, 'Please type the *4-digit code* from the email — or send *hi* to cancel.');
        return;
      }
      const user = await store.upsertUser(mobile);
      const email = (await sessionContext(mobile)).email_pending;
      const out = await require('../mail/emailCode').verifyCode(user.id, email, code);
      if (out.ok) {
        await setState(mobile, 'owner_start', 'email confirmed');
        await funnel(mobile, 'email_confirmed');
        await reply(mobile, `✅ *Email confirmed* — ${out.user.email}\n\nYour reports, receipts and vehicle alerts will go there too.`,
          ['check', { id: BTN.MY_MONITORING, title: 'My monitoring' }, 'menu']);
        return;
      }
      if (out.error === 'wrong_code') { await send.text(mobile, `${out.message}\n\n_Type the code again, or send *hi* to cancel._`); return; }
      await setState(mobile, 'owner_start', `email code: ${out.error}`);
      await reply(mobile, out.message, [{ id: BTN.EMAIL_RESEND, title: 'Send new code' }, { id: BTN.EMAIL_CHANGE, title: 'Change email' }, 'menu']);
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
      {
        const act = require('../util/activity');
        act.whoOf(mobile).then((who) => act.log('💬', `Feedback${reg ? ` about ${reg}` : ''} · “${String(intent.text || `[${message.type}]`).slice(0, 150)}”`,
          { who, detail: 'WhatsApp' })).catch(() => {});
      }
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
          AGREE_BUTTONS());
        return;
      }
      /* NO AGREEMENT ON FILE AT ALL (user, 2026-10-09: a customer who paid on
         5 Oct had none, so the alerts' consent gate refused them). Asked once,
         like a Terms update — whatever path brought them here. */
      if (!agreed && !(await send.agreedTerms(mobile))) {
        await setState(mobile, 'owner_consent', 'no agreement on file');
        await send.buttons(mobile,
          'Before we continue, please agree to our Terms.\n\n' + OWNER_TERMS,
          AGREE_BUTTONS());
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
        'Please tap *Agree & continue* (or *Agree, news & offers*) above to proceed. '
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

module.exports = { handle, welcome, recordConsent, checkFromWaitlist, BTN, emailNudge, _sendValidReport: (m, r) => sendValidReport(m, r) };
