/**
 * src/routes/checkout.js
 * ---------------------------------------------------------------------------
 * The page between WhatsApp and Razorpay.
 *
 *   GET  /pay/:token     the order summary, with a Pay button
 *   POST /pay/:token/verify   the success callback from Razorpay Checkout
 *
 * WHY A PAGE OF OUR OWN, when a payment link already works: a link ends on
 * Razorpay's site and hands us nothing. We learn about the money only when a
 * webhook arrives, and a webhook can be late, misrouted or lost — one real test
 * payment sat unacknowledged for seven minutes for exactly that reason.
 *
 * Razorpay Checkout, opened from our page, gives the browser a success callback
 * carrying a SIGNED payment id. We verify that signature server-side and
 * activate immediately, so by the time the customer is back in WhatsApp the
 * confirmation, the report and the invoice are already waiting.
 *
 * The webhook and the reconciler stay exactly as they were. This is the fast
 * path; they are what makes it safe for the fast path to fail.
 *
 * NO LOGIN, by design. The token is unguessable, belongs to one payment, and
 * grants nothing except the right to pay that one amount.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../db');
const rzp = require('../pay/razorpay');
const billing = require('../pay/billing');
const settings = require('../util/settings');
const fs = require('fs');

const router = express.Router();

const WA_NUMBER = process.env.WHATSAPP_BUSINESS_PHONENUMBER || '917996083415';   // the live number since 2026-10-23 (7353… disabled 21 Oct)
const SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://gaadipe.in').replace(/\/+$/, '');
const { config } = require('../config');

/*
 * WHERE A WEBSITE BUYER GOES BACK TO: the site they came from. The checkout
 * page is opened through the site's own origin (the site proxies /pay in
 * development), so the Referer names the site as the customer is using it —
 * localhost, a phone on the Wi-Fi, a tunnel, gaadipe.in. In production only the
 * site's known origins are trusted; anything else falls back to PUBLIC_SITE_URL,
 * so this can never be used to bounce a customer to someone else's page.
 */
function siteOrigin(req) {
  try {
    const origin = new URL(req.get('referer') || '').origin;
    if (!/^https?:\/\//.test(origin)) return SITE_URL;
    const production = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    return !production || config.site.origins.includes(origin) ? origin : SITE_URL;
  } catch {
    return SITE_URL;
  }
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Back to the GaadiPe chat — the APP, not wa.me's web landing page.
 *
 * WHY NOT JUST location.href = wa.me: after a UPI payment the customer returns
 * to the browser from their UPI app, the success callback runs with no tap
 * behind it, and Android Chrome then refuses to hand a wa.me navigation to the
 * WhatsApp app. They are left on a "Continue to chat" web page, which reads as
 * "something went wrong".
 *
 * So: an intent URL on Android (opens WhatsApp or WhatsApp Business, falling
 * back to wa.me), the whatsapp:// scheme on iOS, wa.me elsewhere — tried
 * automatically, AND offered as a big button, because a tap is the one thing
 * every browser lets through.
 */
/*
 * `text` is typed into the chat for them. A customer who paid on the website
 * may never have written to the number, and WhatsApp lets the bot send a PDF
 * only inside 24 hours of THEIR last message — so the chat opens with "Report"
 * ready, and pressing Send is what lets the report through.
 */
const waJs = (text = '') => {
  const q = text ? `&text=${encodeURIComponent(text)}` : '';
  return `
  var WA_WEB = 'https://wa.me/${WA_NUMBER}${text ? `?text=${encodeURIComponent(text)}` : ''}';
  function waUrl() {
    var ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) {
      return 'intent://send/?phone=${WA_NUMBER}${q}#Intent;scheme=whatsapp;'
        + 'S.browser_fallback_url=' + encodeURIComponent(WA_WEB) + ';end';
    }
    if (/iPhone|iPad|iPod/i.test(ua)) return 'whatsapp://send?phone=${WA_NUMBER}${q}';
    return WA_WEB;
  }
  function openWhatsApp() { location.href = waUrl(); return false; }
`;
};
const waButton = (label = 'Open WhatsApp', text = '') =>
  `<button onclick="return openWhatsApp()">${esc(label)}</button>
   <p class="muted" style="text-align:center;margin:10px 0 0">
     Not opening? <a href="https://wa.me/${WA_NUMBER}${text ? `?text=${encodeURIComponent(text)}` : ''}">Tap here</a></p>
   <script>${waJs(text)}</script>`;

/*
 * THE WAY OUT OF A DEAD END (user, 2026-09-22).
 *
 * Every screen here that cannot go forward has to offer something. While
 * GaadiPe has no WhatsApp number (config.whatsapp.enabled), sending someone to
 * a chat nobody reads is worse than saying nothing — so the button goes to the
 * website instead, and the words alongside it change with it. Turning the
 * number on brings the WhatsApp version back with no other edit.
 */
const WA_ON = () => config.whatsapp.enabled;
const siteButton = (url, label) =>
  `<button onclick="location.href=${esc(JSON.stringify(url))}">${esc(label)}</button>`;
const wayOut = (url, { wa = 'Open WhatsApp', web = 'Open GaadiPe' } = {}) =>
  (WA_ON() ? waButton(wa) : siteButton(url, web));
/** "on WhatsApp" is a promise GaadiPe cannot keep today; the inbox is. */
const sentTo = () => (WA_ON() ? 'in your WhatsApp chat' : 'in your email');

/* The checkout's pre-fills (user, 2026-09-26). */
// Email can be skipped only when the report is delivered in the WhatsApp chat;
// a website purchase is delivered by email, so there it stays required.
// A check pack (raw.checks, migration 213) delivers nothing by email, so an address is never required for it.
const emailIsOptional = (pay) => Boolean(pay.raw?.checks) || (WA_ON() && pay.raw?.channel !== 'web');
// A WhatsApp profile name as an invoice name: emoji and symbols dropped, and
// nothing at all if what is left is not a name.
const cleanName = (n) => {
  const s = String(n || '').replace(/[^\p{L}\p{M}\s.'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return /\p{L}{2}/u.test(s) ? s : '';
};
// The GST state code for a plate's state (KA -> 29). Matched by name against
// the invoice's list, so the two lists cannot drift apart. BH plates say nothing.
const PLATE_ALIASES = { OR: 'OD', UA: 'UK', CT: 'CG', TG: 'TS', DN: 'DD' };
function gstStateOfPlate(regNo) {
  const letters = String(regNo || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2);
  const name = require('../admin/geo').STATES[PLATE_ALIASES[letters] || letters];
  if (!name) return null;
  const { STATES } = require('../pay/invoice');
  const hit = Object.entries(STATES).find(([, n]) => n.toLowerCase() === name.toLowerCase());
  return hit ? hit[0] : null;
}

const page = (title, body) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · GaadiPe</title>
<style>
  :root { --brand:#0F766E; --ink:#0B1F1C; --body:#41514E; --line:#E3ECEA;
          --soft:#F3F8F7; --bad:#B42318; }
  /* The "continue on the web" note (user, 2026-10-23: "a little shake, a little red, so they notice"):
     a soft red box that nudges side to side twice after the page opens, then rests. */
  /* Light blue, not red (user, 2026-10-23: "red looks like an error or a warning") — information, still nudged. */
  .wa-note { margin:12px 0 0; padding:10px 12px; border-radius:10px; background:#eaf4ff; border:1px solid #9ec5f8;
             color:#0b57d0; font-weight:700; line-height:1.4; animation: wa-nudge .7s ease-in-out .8s 2; }
  @keyframes wa-nudge { 0%,100% { transform:translateX(0); } 20% { transform:translateX(-5px); } 40% { transform:translateX(5px); }
                        60% { transform:translateX(-3px); } 80% { transform:translateX(3px); } }
  @media (prefers-reduced-motion: reduce) { .wa-note { animation:none; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--soft); color:var(--ink);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:440px; margin:0 auto; padding:20px 16px 40px; }
  .brand { display:flex; align-items:center; gap:10px; margin:8px 0 18px; }
  .brand b { font-size:19px; letter-spacing:-.2px; }
  .brand span { color:var(--body); font-size:12px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px;
          padding:18px; margin-bottom:14px; }
  h1 { font-size:16px; margin:0 0 14px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:7px 0;
         font-size:14px; color:var(--body); }
  .row b { color:var(--ink); font-weight:600; text-align:right; }
  .total { border-top:1px solid var(--line); margin-top:8px; padding-top:12px;
           font-size:17px; color:var(--ink); font-weight:700; }
  .veh { font-size:20px; font-weight:700; letter-spacing:.5px; }
  .muted { color:var(--body); font-size:12.5px; }
  ul { margin:8px 0 0; padding-left:18px; color:var(--body); font-size:13.5px; }
  li { margin:3px 0; }
  button { width:100%; padding:15px; border:0; border-radius:12px;
           background:var(--brand); color:#fff; font-size:16px; font-weight:600;
           cursor:pointer; }
  button:disabled { opacity:.55; }
  a { color:var(--brand); }
  .foot { text-align:center; color:var(--body); font-size:11.5px; margin-top:18px; }
  .err { color:var(--bad); font-size:13.5px; margin-top:10px; text-align:center; }
  .fld { display:block; margin:0 0 10px; }
  .fld span { display:block; font-size:12px; font-weight:600; color:var(--body); margin-bottom:4px; }
  .fld input, .fld select { width:100%; padding:11px 12px; border:1px solid var(--line); border-radius:10px;
           font:inherit; color:var(--ink); background:#fff; }
</style>
</head><body><div class="wrap">
<div class="brand"><b>GaadiPe</b><span>Har gaadi ki kundli.</span></div>
${body}
<div class="foot">Powered by ServerPe App Solutions · GSTIN 29BSMPK7696H1ZT</div>
</div></body></html>`;

/* ------------------------------------------------------------- the summary */

/**
 * Express 4 does not catch a rejected promise from an async handler, and an
 * unhandled rejection stops the process — so one database error on this
 * public page would take the webhooks and the jobs down with it. Every async
 * route here goes through this.
 */
const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error('[checkout] %s %s failed: %s', req.method, req.path, e.message);
  if (res.headersSent) return;
  if (req.method === 'GET') {
    res.status(500).send(page('Something went wrong', `<div class="card">
      <h1>Something went wrong</h1>
      <p class="muted">Please try again in a minute.</p></div>`));
  } else {
    // The money may already be taken; the webhook and the reconciler finish the
    // job, so this must not invite a second payment.
    res.status(500).json({ ok: false, message: config.whatsapp.enabled
      ? 'We could not confirm the payment yet. Please check WhatsApp in a minute.'
      : 'We could not confirm the payment yet. Your money is safe — check your email in a minute, or write to support@gaadipe.in.' });
  }
});

router.get('/pay/:token', safe(async (req, res) => {
  const pay = await db.one(
    `SELECT p.*, u.mobile, u.wa_profile_name, u.display_name, u.state_code, u.email,
            v.reg_no, v.maker, v.model, pl.duration_days,
            pl.kind AS plan_kind, pl.price_paise AS plan_price_paise, pl.monitoring AS plan_monitoring
       FROM payments p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN plans pl ON pl.id = p.plan_id
       LEFT JOIN vehicles v ON v.id = (p.raw->>'vehicle_id')::bigint
      WHERE p.checkout_token = $1`, [req.params.token]);

  if (!pay) {
    return res.status(404).send(page('Not found', `<div class="card">
      <h1>This payment link is not valid</h1>
      <p class="muted">It may have already been used. ${WA_ON()
        ? 'Please go back to WhatsApp and ask for a new one.'
        : 'Open GaadiPe, check the vehicle again and start a new payment — nothing has been charged.'}</p>
      ${wayOut(`${SITE_URL}/app/check`, { web: 'Open GaadiPe' })}</div>`));
  }

  const web = pay.raw?.channel === 'web';
  const site = siteOrigin(req);

  // The command center's "payment page viewed" (user, 2026-09-25): the first
  // time this checkout is opened while still unpaid — reopening it is not a
  // second view.
  if (pay.status !== 'paid') {
    require('../events/track').fire({
      key: `pay_view:${pay.id}`, name: 'payment_page_viewed', channel: web ? 'web' : 'whatsapp',
      userId: pay.user_id, mobile: pay.mobile, regNo: pay.reg_no, paymentId: pay.id,
      amountPaise: pay.amount_paise,
    });
  }

  if (pay.status === 'paid' && pay.plan_kind === 'sticker') {
    return res.send(page('Already paid', `<div class="card">
      <h1>This payment is already complete ✅</h1>
      <p class="muted">Your GaadiPe Tag sticker for <b>${esc(pay.reg_no || 'your vehicle')}</b> is ordered — we post it within 2 working days and send the tracking number on WhatsApp.</p>
      ${wayOut(`${site}/chat`, { wa: 'Back to WhatsApp', web: 'Open GaadiPe' })}</div>`));
  }
  if (pay.status === 'paid' && pay.plan_kind === 'checks') {
    return res.send(page('Already paid', `<div class="card">
      <h1>This payment is already complete ✅</h1>
      <p class="muted">Your ${Number(pay.raw?.checks) || 5} vehicle checks are ready to use. Send any vehicle number to check it.</p>
      ${web ? `<button onclick="location.href=${esc(JSON.stringify(`${site}/chat`))}">Check a vehicle</button>`
        : wayOut(`${site}/chat`, { wa: 'Back to WhatsApp', web: 'Check a vehicle' })}</div>`));
  }
  if (pay.status === 'paid') {
    return res.send(page('Already paid', web ? `<div class="card">
      <h1>This payment is already complete ✅</h1>
      <p class="muted">${pay.plan_kind === 'replace'
        ? `Monitoring has moved to <b>${esc(pay.reg_no || 'your vehicle')}</b>; its GST invoice is in your GaadiPe account.`
        : `Your full report for <b>${esc(pay.reg_no || 'your vehicle')}</b> and its GST invoice are in your GaadiPe account.`}</p>
      <button onclick="location.href=${esc(JSON.stringify(`${site}/app/reports`))}">Open my reports</button></div>`
      : `<div class="card">
      <h1>This payment is already complete ✅</h1>
      <p class="muted">${pay.plan_kind === 'replace'
        ? `Monitoring has moved to <b>${esc(pay.reg_no || 'your vehicle')}</b>.`
        : pay.plan_kind === 'report'
        ? `Your full report for <b>${esc(pay.reg_no || 'your vehicle')}</b> has been sent.`
        : `Monitoring for <b>${esc(pay.reg_no || 'your vehicle')}</b> is active.`}
      The confirmation and invoice are ${sentTo()}.</p>
      ${wayOut(`${site}/app/reports`, { wa: 'Back to WhatsApp', web: 'Open my reports' })}</div>`));
  }

  /*
   * BILLED TO (user, 2026-09-21): the name printed on the GST invoice, and the
   * state or union territory — the place of supply, which decides CGST + SGST
   * (the home state) or IGST (anywhere else). Both required before paying,
   * pre-filled from what was entered on the site, and the tax lines follow the
   * state as it is chosen. The split is the invoice's own arithmetic
   * (pay/invoice.js), in paise, so the page and the invoice cannot disagree.
   */
  const { STATES } = require('../pay/invoice');
  const biz = await db.one(`SELECT home_state_code FROM business_details WHERE is_active ORDER BY id DESC LIMIT 1`) || {};
  const home = String(biz.home_state_code || '29');
  /* FEWER THINGS TO TYPE BEFORE ₹19 (user, 2026-09-26): 3 of 5 who opened
     this page left without paying. The name comes from their WhatsApp
     profile, the state from their vehicle's registration (both editable), and
     the email is optional when the report is delivered in the chat. */
  const buyerName = pay.raw?.buyer_name || pay.display_name || cleanName(pay.wa_profile_name);
  const knownState = String(pay.raw?.buyer_state_code || pay.state_code || '');
  const buyerState = knownState || gstStateOfPlate(pay.reg_no) || '';
  const stateGuessed = !knownState && Boolean(buyerState);
  const emailOptional = emailIsOptional(pay);
  const grossPaise = pay.amount_paise;
  const basePaise = Math.round(grossPaise / 1.18);
  const taxPaise = grossPaise - basePaise;
  const cgstPaise = Math.round(taxPaise / 2);
  const gross = grossPaise / 100;
  const taxable = basePaise / 100;
  const stateOptions = Object.entries(STATES).sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => `<option value="${code}"${code === buyerState ? ' selected' : ''}>${esc(name)}</option>`).join('');
  const vehicleName = [pay.maker, pay.model].filter(Boolean).join(' ')
    .toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase());

  const isReport = pay.plan_kind === 'report';
  // Replace vehicle (2026-10-13; pay/replace.js): monitoring moves from the old vehicle to this one.
  const isReplace = pay.plan_kind === 'replace';
  // A check pack (migration 213): no vehicle - checks, and how long they last.
  const isChecks = pay.plan_kind === 'checks';
  // A GaadiPe Tag sticker, delivered (migration 218): the vehicle, and where it goes.
  const isSticker = pay.plan_kind === 'sticker';
  const stick = pay.raw?.sticker || {};
  const packSize = Number(pay.raw?.checks) || 5;
  const rep = pay.raw?.replace || {};
  /* A payment started on the website must end on the website: sending a web
     customer to WhatsApp would hand them to a different product than the one
     they were using. The channel was recorded when the order was created. */
  // ?paid=1 so the page they land on can say what has just been emailed to them.
  //
  // WHATSAPP-FIRST (user, 2026-09-25): while GaadiPe is on WhatsApp the site has
  // no account area to go back to, so every payment ends in the chat — even one
  // started on the web. That one opens with "Report" typed (see waJs).
  // THE CHAT (2026-10-07): a web payment ALWAYS returns to the conversation on
  // gaadipe.in, which opens the full report and its PDF there (/chat?paid=REG) —
  // whatever WHATSAPP_ENABLED says. With the WhatsApp account disabled, "Open
  // WhatsApp" after paying sent a paying customer to a dead end.
  // &amt= the rupees paid, for the website's Meta Pixel Purchase (user, 2026-10-22) — the amount only.
  const amt = Math.round(Number(pay.amount_paise) || 0) / 100;
  const backUrl = web
    ? (isReplace ? `${site}/chat?open=subs&amt=${amt}`
      : isChecks ? `${site}/chat?checks=${packSize}&amt=${amt}`
      : `${site}/chat?paid=${encodeURIComponent(pay.reg_no || '1')}&amt=${amt}`)
    : null;
  void WA_ON;
  const chatText = web ? 'Report' : '';
  const validDays = await settings.num('report_valid_days', 7);
  const planLine = isSticker
    ? `GaadiPe Tag sticker · delivered to ${stick.pincode || 'your pincode'}`
    : isChecks
    ? `${packSize} vehicle checks · valid ${pay.duration_days || 30} days`
    : isReplace
    ? `Replace vehicle · ${rep.from_reg || ''} → ${rep.to_reg || pay.reg_no || ''}`
    : isReport
    // The one-time report (REPORT11, 2026-10-25) says so; the ₹19 names its alerts.
    ? (pay.plan_monitoring === false ? 'Full vehicle report · one time' : `Full vehicle report + ${pay.duration_days || 28} days of alerts`)
    : `GaadiPe Watch · ${pay.duration_days || 28} days`;
  const where = web ? 'in your GaadiPe account' : 'on WhatsApp';
  const benefits = isSticker
    ? ['A printed, weatherproof QR sticker for your vehicle',
       `Posted within 2 working days to pincode ${stick.pincode || ''}${stick.label ? ` (${stick.label})` : ''} — delivery included`,
       'Tracking number on WhatsApp once it is posted',
       'Anyone who scans it reaches you on WhatsApp — your number stays private',
       `GST invoice ${where}`]
    : isChecks
    ? [`${packSize} vehicle checks — make, model, insurance, PUC, tax, fitness and challan status of any vehicle`,
       `Valid for ${pay.duration_days || 30} days; a vehicle you already checked is free to check again, any time`,
       'Use them on WhatsApp or on gaadipe.in',
       'Unused checks expire and are not refunded',
       `GST invoice ${where}`]
    : isReplace
    ? [`Your running monitoring moves from ${rep.from_reg || 'the old vehicle'} to ${rep.to_reg || pay.reg_no || 'this vehicle'} — same end date`,
       'New challans watched, and a warning before insurance, PUC, road tax, fitness or permit expires',
       `${rep.from_reg || 'The old vehicle'} comes off your list and its alerts stop; its report and invoice stay`,
       'The full report of the new vehicle is not included',
       `GST invoice ${where}, and emailed to you`]
    : isReport
    ? [`Full report PDF ${where}, and emailed to you — download again for ${validDays} days`,
       'Loan / hypothecation, blacklist and NOC status',
       'Every challan, with offence, place and amount',
       'Insurer, policy and PUC references',
       ...(pay.plan_monitoring === false
         ? ['One time — no alerts or monitoring for this vehicle']
         : [`New challans watched for ${pay.duration_days || 90} days`,
            'A warning before insurance, PUC, road tax or fitness expires']),
       `GST invoice ${where}, and emailed to you`]
    : ['Daily checks on this vehicle',
       'A message the moment a new challan appears',
       'Reminders before insurance, PUC or fitness expires',
       'Full details: financer, policy numbers',
       'GST invoice on WhatsApp'];

  res.send(page('Checkout', `${pay.raw?.test_mode ? `
<div class="card" style="background:#fff4e0;border:2px dashed #e08700;color:#7a4a00;text-align:center;font-weight:700">
  🧪 TEST MODE — owner only. Razorpay test keys: no real money moves. Use a Razorpay test card or test UPI (success@razorpay).
</div>` : ''}
<div id="done" class="card" style="display:none">
  <h1>Payment successful ✅</h1>
  <p class="muted" style="margin:0 0 14px">${isSticker
    ? `Your GaadiPe Tag sticker for <b>${esc(pay.reg_no || '')}</b> is ordered. The confirmation and GST invoice are on their way to your WhatsApp chat.`
    : isChecks
    ? `${packSize} vehicle checks have been added. ${web ? 'Send any vehicle number in the chat to use one.' : 'The confirmation and GST invoice are on their way to your WhatsApp chat.'}`
    : isReplace
    ? `Monitoring has moved from <b>${esc(rep.from_reg || '')}</b> to <b>${esc(rep.to_reg || pay.reg_no || '')}</b>. ${web ? 'It shows under My subscriptions.' : 'The confirmation and GST invoice are on their way to your WhatsApp chat.'}`
    : backUrl
    ? `Your full report for <b>${esc(pay.reg_no || '')}</b> is ready — it opens in your GaadiPe chat with a Download PDF button.`
    : web
    ? `Your full report for <b>${esc(pay.reg_no || '')}</b> is ready. WhatsApp opens with <b>Report</b> typed — press Send and it arrives in the chat.`
    : isReport
    ? `Your full report for <b>${esc(pay.reg_no || '')}</b> is on its way to your WhatsApp chat.`
    : 'Your confirmation is on its way to your WhatsApp chat.'}</p>
  <p class="muted" id="mailedTo" style="margin:0 0 14px"></p>
  <p class="muted" style="margin:0 0 14px">${backUrl ? 'Taking you back to the chat…' : 'Opening WhatsApp…'}</p>
  ${backUrl
    ? `<button onclick="location.href=${JSON.stringify(backUrl)}">${isReplace ? 'Open My subscriptions' : isChecks ? 'Check a vehicle' : 'Open my report in the chat'}</button>`
    : waButton('Open WhatsApp', chatText)}
</div>

<!--
  ONE SCREEN, ONE BUTTON (user, 2026-10-25: "I don't know why people leave at the payment view"). The page read
  like a tax form - GST lines, a "Billed to" form and the Pay button at the very bottom. Now: what they buy and
  the price "GST included" at the top with the Pay button and who handles the money; the invoice details folded
  into one line with Edit (open only when something is missing); the GST breakdown inside it; a Pay bar that
  stays at the bottom of the screen. The invoice itself is unchanged.
-->
<div id="main" style="padding-bottom:84px">
<div class="card">
  <div class="veh">${isChecks ? `🔢 ${packSize} checks` : esc(pay.reg_no || '')}</div>
  ${vehicleName ? `<div class="muted">${esc(vehicleName)}</div>` : ''}
  <div style="margin-top:8px;font-weight:700">${esc(planLine)}</div>
  ${pay.raw?.referral_credit_id && pay.plan_price_paise > grossPaise ? `<div class="muted">Referral reward (QuizPe): ₹${(pay.plan_price_paise / 100).toFixed(2)} → ₹${gross.toFixed(2)}</div>` : ''}
  <div style="margin:10px 0 2px;font-size:34px;font-weight:900;letter-spacing:-.5px">₹${grossPaise % 100 ? gross.toFixed(2) : gross.toFixed(0)}
    <span style="font-size:14px;font-weight:600;color:#5d6b67">· GST included</span></div>
  <!-- THE GST BREAKUP IN SIGHT (user, 2026-10-26: "in checkout, show at least the GST breakup"): taxable value + GST,
       split as CGST + SGST or IGST by the state chosen below (renderTax). -->
  <div id="gstLine" style="font-size:13px;color:#41514e">₹${taxable.toFixed(2)} + GST ₹${(taxPaise / 100).toFixed(2)} (18%)</div>
  <button id="pay" style="margin-top:10px">Pay ₹${grossPaise % 100 ? gross.toFixed(2) : gross.toFixed(0)} securely</button>
  <div id="err" class="err"></div>
  <p style="margin:10px 0 0;text-align:center;font-size:13px;color:#41514e">🔒 Secured by <b>Razorpay</b> · UPI, cards, netbanking</p>
  <p style="margin:6px 0 0;text-align:center;font-size:12px;color:#5d6b67">GPay · PhonePe · Paytm · BHIM · any UPI app</p>
</div>

<div class="card">
  <details id="billed"${buyerName && buyerState ? '' : ' open'}>
  <summary style="cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:8px;align-items:center">
    <span><span class="muted">Invoice to:</span> <b id="billedTo">${esc([buyerName, STATES[buyerState]].filter(Boolean).join(', ') || 'your name and state')}</b></span>
    <span style="color:#0f766e;font-weight:700;white-space:nowrap">Edit</span>
  </summary>
  <div style="margin-top:10px">
  <label class="fld"><span>Name on the invoice</span>
    <input id="bname" maxlength="80" autocomplete="name" placeholder="Your full name" value="${esc(buyerName)}"></label>
  <label class="fld"><span>State / union territory</span>
    <select id="bstate"><option value="">Choose…</option>${stateOptions}</select></label>
  <p class="muted" style="margin:6px 0 0">${stateGuessed
    ? 'Picked from your vehicle’s registration — change it if you live in another state. '
    : ''}For your GST invoice. Your state is the place of supply — it decides
  CGST + SGST or IGST. The price stays the same.</p>
  <label class="fld" style="margin-top:10px"><span>${emailOptional
    ? 'Email (optional) — add it to get your invoice and daily updates by email'
    : 'Email — for your invoice and daily vehicle updates'}</span>
    <input id="bemail" type="email" inputmode="email" maxlength="160" autocomplete="email" placeholder="you@example.com" value="${esc(pay.email || '')}"></label>
  <p class="muted" style="margin:6px 0 0">${emailOptional
    ? 'Your report and invoice arrive in your WhatsApp chat either way. '
    : ''}Name, phone (${esc('+91 ' + String(pay.mobile).slice(-10))})${emailOptional ? ' and email, if given,' : ' and email'} are printed on the invoice.</p>
  <div style="margin-top:12px;border-top:1px solid #e3ece9;padding-top:8px">
    <div class="row"><span>Taxable value</span><b>₹${taxable.toFixed(2)}</b></div>
    <div id="tax"></div>
    <div class="row total"><span>Total</span><b>₹${gross.toFixed(2)}</b></div>
  </div>
  </div>
  </details>
</div>

<div class="card">
  <h1>What you get</h1>
  <ul>
    ${benefits.map(b => `<li>${esc(b)}</li>`).join('')}
  </ul>
  <p class="muted" style="margin:12px 0 0"><b>No auto-renewal.</b>
  Nothing is charged automatically, now or later.</p>
  <!-- (user, 2026-10-23) What they buy belongs to their mobile number, not to WhatsApp: if WhatsApp is ever
       unavailable, the report, invoice and alerts are all on the website with the same number. -->
  <!-- Highlighted (user, 2026-10-23: "make it blue or a highlight colour so the customer understands"). -->
  <p class="wa-note">ℹ️ If WhatsApp is ever disabled, you can continue on the web.</p>
</div>

<p class="muted" style="margin:12px 0 0;text-align:center">
  By paying you accept our
  <a href="${esc(site)}/terms" target="_blank" rel="noopener">Terms</a>,
  <a href="${esc(site)}/refund" target="_blank" rel="noopener">Refund</a> and
  <a href="${esc(site)}/privacy" target="_blank" rel="noopener">Privacy</a> policies.
</p>
</div>

<!-- Always within reach: the same Pay, at the bottom of the screen. -->
<div id="payBar" style="position:fixed;left:0;right:0;bottom:0;z-index:20;background:#fff;border-top:1px solid #e3ece9;padding:10px 14px calc(10px + env(safe-area-inset-bottom));box-shadow:0 -6px 18px rgba(0,0,0,.08)">
  <div style="max-width:520px;margin:0 auto">
    <button id="pay2">Pay ₹${grossPaise % 100 ? gross.toFixed(2) : gross.toFixed(0)} securely · Razorpay</button>
  </div>
</div>

<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  var btn = document.getElementById('pay'), err = document.getElementById('err');
  var bname = document.getElementById('bname'), bstate = document.getElementById('bstate'),
      bemail = document.getElementById('bemail');
  var pay2 = document.getElementById('pay2'), billedTo = document.getElementById('billedTo'),
      billed = document.getElementById('billed'), ready = false;
  var EMAIL_RE = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]{2,}$/;
  var HOME = ${JSON.stringify(home)}, TAX = ${taxPaise}, CGST = ${cgstPaise}, TAXABLE = ${basePaise}, EMAIL_OPTIONAL = ${emailOptional};
  function rs(p) { return '₹' + (p / 100).toFixed(2); }
  // The tax lines follow the state: CGST + SGST at home, IGST anywhere else.
  function renderTax() {
    var s = bstate.value, el = document.getElementById('tax');
    el.innerHTML = !s
      ? '<div class="row"><span>GST @ 18%</span><b>' + rs(TAX) + '</b></div>'
      : s === HOME
      ? '<div class="row"><span>CGST @ 9%</span><b>' + rs(CGST) + '</b></div>'
        + '<div class="row"><span>SGST @ 9%</span><b>' + rs(TAX - CGST) + '</b></div>'
      : '<div class="row"><span>IGST @ 18%</span><b>' + rs(TAX) + '</b></div>';
    // The line under the price says the same split.
    document.getElementById('gstLine').textContent = rs(TAXABLE) + ' + GST ' + rs(TAX)
      + (!s ? ' (18%)' : s === HOME ? ' (CGST ' + rs(CGST) + ' + SGST ' + rs(TAX - CGST) + ')' : ' (IGST 18%)');
    var mail = bemail.value.trim();
    // Ready to pay? The buttons stay tappable either way: a tap with something missing opens the details and
    // says what (a disabled button cannot be tapped, and so cannot explain itself).
    ready = !(bname.value.trim().length < 2 || !s || (mail ? !EMAIL_RE.test(mail) : !EMAIL_OPTIONAL));
    btn.disabled = false; pay2.disabled = false;
    btn.style.opacity = pay2.style.opacity = ready ? '1' : '.75';
    // The folded line follows the fields.
    var stName = s ? bstate.options[bstate.selectedIndex].text : '';
    billedTo.textContent = [bname.value.trim(), stName].filter(Boolean).join(', ') || 'your name and state';
  }
  bname.oninput = renderTax; bstate.onchange = renderTax; bemail.oninput = renderTax; renderTax();
  // Paid: swap the order summary for the success card, and try to open the
  // chat straight away. The card's button covers browsers that block that.
  function done() {
    document.getElementById('main').style.display = 'none';
    document.getElementById('payBar').style.display = 'none';
    document.getElementById('done').style.display = 'block';
    // Say where it is going, in the address they typed a moment ago. It is the
    // one place the buyer learns that the report and the invoice will be in
    // their inbox — GaadiPe has no WhatsApp number to send them to.
    var mail = (bemail.value || '').trim();
    if (mail) {
      document.getElementById('mailedTo').innerHTML =
        'Your report and GST invoice are on their way to <b>' + mail.replace(/[<>&]/g, '') + '</b>.';
    }
    window.scrollTo(0, 0);
    ${backUrl
      // Long enough to read the line above, short enough not to feel stuck.
      ? `setTimeout(function () { location.href = ${JSON.stringify(backUrl)}; }, 2600);`
      : 'setTimeout(openWhatsApp, 600);'}
  }
  // Billed-to first: saved on the payment, which is what the invoice prints.
  btn.onclick = function () {
    // Something missing (a name, the state): open the folded details and say so, rather than a dead button.
    if (btn.disabled) return;                       // already on its way
    if (!ready) {
      if (billed) billed.open = true;
      err.textContent = 'Please add your name and state for the GST invoice' + (EMAIL_OPTIONAL ? '' : ', and your email') + '.';
      if (billed) billed.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    btn.disabled = true; pay2.disabled = true; err.textContent = '';
    fetch(location.pathname + '/buyer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: bname.value.trim(), state_code: bstate.value, email: bemail.value.trim() })
    }).then(function (x) { return x.json(); }).then(function (out) {
      if (!out.ok) { err.textContent = out.message || 'Please check your name and state.'; renderTax(); return; }
      openCheckout();
    }).catch(function () { err.textContent = 'Please check your connection and try again.'; renderTax(); });
  };
  function openCheckout() {
    var rz = new Razorpay({
      key: ${JSON.stringify(rzp.keyFor(pay))},
      order_id: ${JSON.stringify(pay.order_id)},
      amount: ${pay.amount_paise},
      currency: 'INR',
      name: 'GaadiPe',
      description: ${JSON.stringify(isSticker ? `Tag sticker — ${pay.reg_no || ''}` : isChecks ? `${packSize} vehicle checks` : `${isReport ? 'Full report' : 'Watch'} — ${pay.reg_no || ''}`)},
      prefill: { contact: ${JSON.stringify('+91' + String(pay.mobile).slice(-10))},
                 name: bname.value.trim(),
                 email: bemail.value.trim() },
      theme: { color: '#0F766E' },
      // Verified server-side before the customer is told anything: the browser
      // could claim any payment succeeded.
      handler: function (r) {
        btn.textContent = 'Confirming…';
        fetch(location.pathname + '/verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r)
        }).then(function (x) { return x.json(); })
          .then(function (out) {
            if (out.ok) {
              done();
            } else {
              err.textContent = out.message || 'We could not confirm the payment yet. Please check WhatsApp in a minute.';
              btn.disabled = false; pay2.disabled = false; btn.textContent = 'Pay again';
            }
          })
          .catch(function () {
            // The money is taken; the reconciler will finish the job within a
            // minute, so send them back rather than inviting a second payment.
            done();
          });
      },
      modal: { ondismiss: function () { renderTax(); } }
    });
    rz.on('payment.failed', function (e) {
      err.textContent = (e.error && e.error.description) || 'Payment failed. Please try again.';
      renderTax();
    });
    rz.open();
  }
  /* ASKED ONCE (user, 2026-10-07: "it asks the summary twice before pay"). Arriving
     from the site's payment window (?go=1), the name, state, email and declaration
     were just given there: save them and open Razorpay at once. This page stays
     underneath, for a second try if Razorpay is closed. */
  pay2.onclick = function () { btn.onclick(); };
  if (/[?&]go=1(&|$)/.test(location.search) && ready) btn.onclick();
</script>`));
}));

/* -------------------------------------------------------------- billed to */

/* The invoice's name and place of supply, saved on this payment (and on the
   account for next time) before Razorpay opens. Only while unpaid. */
router.post('/pay/:token/buyer', express.json(), safe(async (req, res) => {
  const { STATES } = require('../pay/invoice');
  const pay = await db.one(`SELECT id, user_id, status, raw FROM payments WHERE checkout_token = $1`, [req.params.token]);
  if (!pay) return res.status(404).json({ ok: false, message: 'This payment link is not valid.' });
  if (pay.status === 'paid') return res.status(409).json({ ok: false, message: 'This payment is already complete.' });
  const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const state = String(req.body?.state_code || '').replace(/\D/g, '').padStart(2, '0');
  if (name.length < 2) return res.status(400).json({ ok: false, message: 'Please enter your name for the invoice.' });
  if (!STATES[state]) return res.status(400).json({ ok: false, message: 'Please choose your state or union territory.' });
  // The email: a new one is sent a confirmation link (mail/customer.js).
  // Required when email is how the report is delivered; optional when it
  // arrives in the WhatsApp chat (user, 2026-09-26).
  const customerMail = require('../mail/customer');
  const email = String(req.body?.email || '').trim();
  if (email || !emailIsOptional(pay)) {
    if (!customerMail.validEmail(email)) {
      return res.status(400).json({ ok: false, message: emailIsOptional(pay)
        ? 'That email does not look right — correct it, or leave it empty.'
        : 'Please enter your email — your invoice and daily vehicle updates are sent there.' });
    }
    await customerMail.setEmail(pay.user_id, email);
  }
  await db.query(
    `UPDATE payments SET raw = COALESCE(raw,'{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [pay.id, JSON.stringify({ buyer_name: name, buyer_state_code: state })]);
  await db.query(
    `UPDATE users SET display_name = $2, state_code = $3, modified_at = now() WHERE id = $1`,
    [pay.user_id, name, state]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------- the success callback */

router.post('/pay/:token/verify', express.json(), safe(async (req, res) => {
  const { razorpay_payment_id: paymentId, razorpay_order_id: orderId,
          razorpay_signature: signature } = req.body || {};

  const pay = await db.one(
    `SELECT * FROM payments WHERE checkout_token = $1`, [req.params.token]);
  if (!pay) return res.status(404).json({ ok: false, message: 'Unknown payment.' });

  // The browser is not trusted. Only Razorpay's signature over
  // "order_id|payment_id" proves this happened.
  if (!rzp.verifyCheckout({ orderId, paymentId, signature, test: Boolean(pay.raw?.test_mode) })) {
    console.warn('[checkout] bad signature for payment %d', pay.id);
    return res.status(400).json({ ok: false, message: 'Could not verify the payment.' });
  }
  if (orderId !== pay.order_id) {
    console.warn('[checkout] order mismatch: %s vs %s', orderId, pay.order_id);
    return res.status(400).json({ ok: false, message: 'Could not verify the payment.' });
  }

  // The device the payment was made from. Recorded here because this is the
  // only point in the whole flow where a browser exists — WhatsApp gives us no
  // user agent and no IP, so a report issued from a chat has nothing to say
  // about the requester's device except that there wasn't one.
  const requester = {
    ip: req.ip,
    userAgent: req.get('user-agent') || null,
    channel: 'web',
  };
  await db.query(
    `UPDATE payments SET raw = COALESCE(raw,'{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [pay.id, JSON.stringify({ paid_from: requester })]);

  const result = await billing.activate({
    paymentRowId: pay.id, razorpayPaymentId: paymentId, orderId,
    raw: { via: 'checkout' },
  });

  if (result.activated) {
    console.log('[checkout] activated %s from the browser callback',
      result.oneTime ? `one-time report (payment ${result.payment.id})`
        : result.sticker ? `tag sticker (payment ${result.payment.id})`
        : result.checks ? `${result.checks} checks (payment ${result.payment.id})` : `subscription ${result.subscription.id}`);
    const { notifyPaid } = require('./payments');
    notifyPaid(result).catch(e => console.error('[checkout] notify:', e.message));
  } else {
    // Already handled by the webhook that beat us to it — still a success.
    console.log('[checkout] payment %d already handled (%s)', pay.id, result.reason);
  }

  res.json({ ok: true });
}));

/* ------------------------------------------------------------ the report */

/**
 * Download a paid report while it is valid.
 *
 *   GET /report/:token
 *
 * The token is unguessable and belongs to one report, like the checkout token.
 * After valid_until the link says so plainly instead of 404ing, because the
 * person holding it did pay, and deserves to know why it stopped working.
 */
router.get('/report/:token', safe(async (req, res) => {
  const r = await db.one(
    `SELECT id, report_number, reg_no, pdf_path, valid_until
       FROM vehicle_reports WHERE access_token = $1`, [req.params.token]);

  if (!r || !r.valid_until) {
    return res.status(404).send(page('Not found', `<div class="card">
      <h1>This report link is not valid</h1>
      <p class="muted">The link may have been mistyped or already replaced.
      ${WA_ON() ? '' : 'Sign in to GaadiPe and open the vehicle — every report you have paid for is there.'}</p>
      ${wayOut(`${SITE_URL}/app`, { web: 'Open my reports' })}</div>`));
  }
  if (new Date(r.valid_until) <= new Date()) {
    return res.status(410).send(page('Link expired', `<div class="card">
      <h1>This download link has expired</h1>
      <p class="muted">The report for <b>${esc(r.reg_no)}</b> could be downloaded until
      ${esc(new Date(r.valid_until).toDateString())}. ${WA_ON()
        ? "Send the vehicle number on WhatsApp to check today's records."
        : "Check the vehicle again on GaadiPe for today's records. Your copy was also emailed to you when you bought it."}</p>
      ${wayOut(`${SITE_URL}/app/vehicle/${encodeURIComponent(r.reg_no || '')}`, { web: 'Check it again' })}</div>`));
  }
  // Rebuilt first if missing or printed with an older layout (pay/rebuild.js).
  r.pdf_path = await require('../pay/rebuild').ensureFile('vehicle_reports', r.id)
    .catch((e) => { console.error('[report] %s rebuild: %s', r.report_number, e.message); return r.pdf_path; });
  if (!r.pdf_path || !fs.existsSync(r.pdf_path)) {
    console.error('[report] %s file missing at %s', r.report_number, r.pdf_path);
    return res.status(404).send(page('Not available', `<div class="card">
      <h1>This report is not available right now</h1>
      <p class="muted">${WA_ON()
        ? 'Reply <b>report</b> on WhatsApp and it will be sent to you.'
        : 'The copy emailed to you when you bought it still works. If you cannot find it, write to support@gaadipe.in and it will be sent again.'}</p>
      ${wayOut(`${SITE_URL}/app/vehicle/${encodeURIComponent(r.reg_no || '')}`, { web: 'Open GaadiPe' })}</div>`));
  }
  res.set('Cache-Control', 'private, no-store');
  res.download(r.pdf_path, `${r.report_number}.pdf`);
}));

module.exports = router;
