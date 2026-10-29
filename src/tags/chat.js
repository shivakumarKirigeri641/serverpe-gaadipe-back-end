/**
 * src/tags/chat.js — GAADIPE TAG ON WHATSAPP (2026-10-29). Called by whatsapp/flow.js before its own routing; returns
 * true when it answered. Everything here is a reply to someone who wrote first, except the owner's alert, which goes
 * as the Utility template gp_tag_alert_v1 when the owner's 24-hour window is shut (else an SMS).
 *
 * THE PERSON WHO SCANNED
 *   "TAG K7Q2XM" (the QR opens WhatsApp with it)  → who the tag is for, the rules, [Agree & continue] [Cancel]
 *   tag_ok:<code>       → the six preset reasons (a list)
 *   tag_r:<code>:<key>  → passed to the owner; "Their reply will come here" · [Send another] [Get my own tag]
 * THE OWNER
 *   tag_rp:<msg> Reply  → "Type your reply" (state tag_reply) → their words, as typed (no links, no abuse) → the scanner
 *   tag_bk:<msg> Block  · tag_rt:<msg> Report (block + the admin is told)
 *   tag_menu / "tag"    → their vehicles → tagv:<vehicle> → the QR card (PDF) · [Order sticker] [Switch off]
 *   tag_ord:<code>      → pincode (state tag_pin) → the charge → [Continue] → name + address (state tag_addr) → Pay
 *
 * Hidden until tag_enabled: only GaadiPe's own numbers can make tags, and only their tags can be scanned (tags.js).
 */
const db = require('../db');
const send = require('../whatsapp/send');
const settings = require('../util/settings');
const T = require('./tags');

const SITE = () => (process.env.PUBLIC_SITE_URL || 'https://gaadipe.in').replace(/\/+$/, '');
const TAG_TEXT = /^\s*tag\s+([a-z0-9]{6})\b/i;
const MENU_WORDS = /^\s*(my\s+)?(tags?|vehicle\s+tags?|gaadipe\s+tags?)\s*$/i;
const ESCAPE = /^\s*(menu|hi|hello|hey|cancel|stop|back|start)\s*$/i;

async function ctx(mobile) {
  return (await db.one(`SELECT state, context FROM whatsapp_sessions WHERE mobile = $1`, [mobile]).catch(() => null)) || { state: null, context: {} };
}
async function setState(mobile, state, patch = {}) {
  await db.query(
    `UPDATE whatsapp_sessions SET state = $2, state_reason = 'tag', context = context || $3::jsonb, modified_at = now() WHERE mobile = $1`,
    [mobile, state, JSON.stringify(patch)]);
}
/** Into a tag step, remembering where they were; back out of it to exactly there. */
async function enter(mobile, state, patch = {}) {
  const s = await ctx(mobile);
  const prev = String(s.state || '').startsWith('tag_') ? (s.context?.tag_prev_state || 'owner_start') : (s.state || 'owner_start');
  await setState(mobile, state, { ...patch, tag_prev_state: prev });
}
async function leave(mobile) {
  const s = await ctx(mobile);
  await setState(mobile, s.context?.tag_prev_state || 'owner_start');
}
async function buttons(mobile, body, list) {
  const out = await send.buttons(mobile, body, list).catch(() => ({ ok: false }));
  if (!out.ok) await send.text(mobile, body).catch(() => {});
  return out;
}
const userOf = (mobile) => db.one(`SELECT * FROM users WHERE mobile = $1`, [mobile]).catch(() => null);
const firstName = (n) => {
  const f = String(n || '').trim().split(/\s+/)[0];
  return f && !/^\d+$/.test(f) ? f : 'there';
};

/* ─────────────────────────────── the person who scanned ─────────────────────────────── */

async function startScan(mobile, code) {
  const tag = await T.byCode(code);
  if (!(await T.live(tag))) {
    await send.text(mobile, '🙏 This GaadiPe Tag is not active right now.\n\nIf you need urgent help with a vehicle, the local traffic police can help.');
    return;
  }
  await db.query(`INSERT INTO event_log (kind, detail) VALUES ('tag_scanned_chat', $1)`,
    [JSON.stringify({ code: tag.code, by: T.ten(mobile).slice(-4) })]).catch(() => {});
  if (T.ten(mobile) === T.ten(tag.owner_mobile)) {
    await buttons(mobile, `🙂 That's *your own* GaadiPe Tag for ${T.masked(tag.reg_no)}.\n\nWhen someone else scans it, they pick a reason and you get it here — your number stays private. Try it from another phone!`,
      [{ id: 'tag_menu', title: '🏷️ My tags' }, { id: 'menu', title: 'Menu' }]);
    return;
  }
  /* A COPIED STICKER (user, 2026-10-29: "QR must not replicate"): the scanner checks the plate against the tag's vehicle;
     on another vehicle they tap Wrong vehicle — the owner and the admin are told, and nothing is sent. */
  await buttons(mobile,
    `🚗 *Contact the owner of ${T.masked(tag.reg_no)}*\n\n`
    + `First check: the number plate should end in *${String(tag.reg_no).slice(-4)}*. If it doesn't, tap *Wrong vehicle*.\n\n`
    + 'GaadiPe passes your message to this vehicle\'s owner. *Your number stays private*, and so does theirs. '
    + 'Please use this only for a genuine reason. Misuse can be reported and blocked.\n\n'
    + `By tapping *Agree & continue* you accept GaadiPe's Terms: ${SITE()}/terms`,
    [{ id: `tag_ok:${tag.code}`, title: '✅ Agree & continue' }, { id: `tag_wrong:${tag.code}`, title: '🚫 Wrong vehicle' },
      { id: 'tag_cancel', title: 'Cancel' }]);
}

/** The sticker is on a vehicle it doesn't belong to: tell the owner and the admin; send nothing. */
async function wrongVehicle(mobile, code) {
  const tag = await T.byCode(code);
  await send.text(mobile, '🙏 Thank you for telling us — we\'ll look into it. Nothing was sent to anyone.');
  if (!tag) return;
  await db.query(`INSERT INTO event_log (user_id, vehicle_id, kind, detail) VALUES ($1, $2, 'tag_wrong_vehicle', $3)`,
    [tag.user_id, tag.vehicle_id, JSON.stringify({ code: tag.code, by: T.ten(mobile).slice(-4) })]).catch(() => {});
  require('../util/adminPing').ping({
    key: `tag_wrong:${tag.code}:${new Date().toISOString().slice(0, 13)}`, severity: 'warning', source: 'tags',
    title: `🚫 GaadiPe Tag ${tag.code} seen on the wrong vehicle`,
    text: `Someone (••${T.ten(mobile).slice(-4)}) scanned tag ${tag.code} of ${tag.reg_no} and said it is on a different vehicle — possibly a copied sticker. Switch it off from the admin's GaadiPe Tag page if needed.`,
  }).catch(() => {});
  await send.buttons(T.ten(tag.owner_mobile),
    `⚠️ Someone scanned your GaadiPe Tag for ${T.masked(tag.reg_no)} and said it is on a *different vehicle*.\n\nIf you didn't put it there, switch this tag off — the QR stops working at once, and you can make a new one.`,
    [{ id: `tag_off:${tag.code}`, title: '🔕 Switch off' }, { id: 'tag_menu', title: '🏷️ My tags' }]).catch(() => {});
}

async function reasons(mobile, code, { agreed = false } = {}) {
  const tag = await T.byCode(code);
  if (!(await T.live(tag))) { await send.text(mobile, '🙏 This GaadiPe Tag is not active right now.'); return; }
  if (agreed) {
    await db.query(`INSERT INTO event_log (kind, detail) VALUES ('tag_consent', $1)`,
      [JSON.stringify({ mobile: T.ten(mobile), code: tag.code, documents: ['terms'], at: new Date().toISOString() })]).catch(() => {});
  }
  const out = await send.list(mobile, {
    body: `What should we tell the owner of *${T.masked(tag.reg_no)}*?`,
    button: 'Choose reason', sectionTitle: 'Reason',
    rows: T.REASONS.map((r) => ({ id: `tag_r:${tag.code}:${r.key}`, title: r.title })),
  }).catch(() => ({ ok: false }));
  if (!out.ok) await send.text(mobile, 'Sorry — something went wrong. Please scan the tag again.').catch(() => {});
}

const REFUSED = {
  own: 'That is your own tag 🙂',
  blocked: '🙏 Sorry — this owner is not accepting messages from you.',
  vehicle_limit: '⏳ The owner has already had several messages in the last hour. Please try again a little later.',
  sender_limit: '⏳ You have reached today\'s limit of messages. Please try again tomorrow.',
};

async function relay(mobile, code, key) {
  const tag = await T.byCode(code);
  const reason = T.reasonOf(key);
  if (!(await T.live(tag)) || !reason) { await send.text(mobile, '🙏 This GaadiPe Tag is not active right now.'); return; }
  const no = await T.refusal(tag, mobile);
  if (no) { await send.text(mobile, REFUSED[no]); return; }

  const m = (await db.query(
    `INSERT INTO tag_messages (tag_id, sender_mobile, reason) VALUES ($1, $2, $3) RETURNING *`,
    [tag.id, T.ten(mobile), reason.text])).rows[0];
  const told = await tellOwner(tag, m, reason);
  await db.query(`UPDATE tag_messages SET status = $2, channel = $3, error = $4 WHERE id = $1`,
    [m.id, told.ok ? 'sent' : 'failed', told.channel || null, told.ok ? null : String(told.error || '').slice(0, 200)]);
  console.log('[tag] %s → owner of %s (%s): %s', T.ten(mobile).slice(-4), tag.code, reason.key, told.ok ? `sent by ${told.channel}` : `FAILED ${told.error}`);

  if (!told.ok) {
    await send.text(mobile, '😕 Sorry — we could not reach the owner just now. If it is urgent, the local traffic police can help.');
    return;
  }
  const own = await T.enabledFor(mobile);
  await buttons(mobile,
    `✅ *Sent to the owner of ${T.masked(tag.reg_no)}*\n\n"${reason.text}"\n\nTheir reply will come here. Your number stays private.`,
    [{ id: `tag_more:${tag.code}`, title: '📩 Send another' }, ...(own ? [{ id: 'tag_menu', title: '🏷️ Get my own tag' }] : [])]);
}

/** WhatsApp in the owner's window; the Utility template outside it; an SMS when neither can go. */
async function tellOwner(tag, m, reason) {
  const owner = T.ten(tag.owner_mobile);
  const body = `🚗 *Message about your vehicle ${T.masked(tag.reg_no)}*\n\n`
    + `Someone near your vehicle says:\n*"${reason.text}"*\n\n`
    + 'Tap *Reply* to answer — we\'ll pass it on. Their number stays private, and so does yours.';
  const btns = [{ id: `tag_rp:${m.id}`, title: '↩️ Reply' }, { id: `tag_bk:${m.id}`, title: '🚫 Block this person' }, { id: `tag_rt:${m.id}`, title: '⚠️ Report' }];
  if (await send.windowOpen(owner)) {
    const out = await send.buttons(owner, body, btns).catch((e) => ({ ok: false, error: e.message }));
    if (out.ok) return { ok: true, channel: 'whatsapp' };
  }
  const tpl = String(await settings.get('tag_alert_template', 'gp_tag_alert_v1') || '').trim();
  if (tpl) {
    const out = await send.template(owner, tpl, [firstName(tag.owner_name), T.masked(tag.reg_no), reason.text],
      { buttons: btns.map((b) => b.id) }).catch((e) => ({ ok: false, error: e.message }));
    if (out.ok) return { ok: true, channel: 'template' };
  }
  const sms = await require('../util/sms').sendTemplate('tag_alert', owner,
    [String(tag.reg_no).replace(/^(.{4}).*(.{4})$/, '$1XX$2'), reason.text]).catch((e) => ({ ok: false, error: e.message }));
  return sms.ok ? { ok: true, channel: sms.simulated ? 'sms_simulated' : 'sms' } : { ok: false, error: sms.error || 'no channel could reach the owner' };
}

/* ─────────────────────────────── the owner answers ─────────────────────────────── */

/** The message this owner may act on: theirs, by id. */
const ownersMessage = (mobile, id) => db.one(
  `SELECT m.*, t.code, t.user_id, v.reg_no, u.mobile AS owner_mobile
     FROM tag_messages m JOIN qr_tags t ON t.id = m.tag_id JOIN vehicles v ON v.id = t.vehicle_id JOIN users u ON u.id = t.user_id
    WHERE m.id = $1 AND u.mobile = $2`, [Number(id) || 0, mobile]);

async function askReply(mobile, id) {
  const m = await ownersMessage(mobile, id);
  if (!m) { await send.text(mobile, 'That message is no longer available.'); return; }
  await enter(mobile, 'tag_reply', { tag_msg_id: m.id });
  await send.text(mobile, `✍️ *Type your reply* for the person near ${T.masked(m.reg_no)} — for example "Coming in 2 minutes".\n\n_Your number stays private. Type *menu* to cancel._`);
}

async function sendReply(mobile, text) {
  const s = await ctx(mobile);
  const m = await ownersMessage(mobile, s.context?.tag_msg_id);
  if (!m) { await leave(mobile); await send.text(mobile, 'That message is no longer available.'); return; }
  const why = T.replyProblem(text);
  if (why) {
    await send.text(mobile, why === 'link' ? '🙏 Links can\'t be passed on — please write your reply in words.'
      : why === 'abuse' ? '🙏 Please keep it polite — that reply can\'t be passed on.'
      : why === 'long' ? '🙏 Please keep it shorter (up to 300 characters).' : 'Please type your reply.');
    return;
  }
  const reply = String(text).trim();
  const out = await send.buttons(m.sender_mobile,
    `💬 *The owner of ${T.masked(m.reg_no)} replied:*\n\n"${reply}"\n\n_Sent through GaadiPe Tag — numbers stay private._`,
    [{ id: `tag_more:${m.code}`, title: '📩 Send another' }]).catch(() => ({ ok: false }));
  await leave(mobile);
  if (!out.ok) {
    await buttons(mobile, '😕 We couldn\'t pass that on — they wrote more than 24 hours ago, so WhatsApp won\'t let us message them now.',
      [{ id: 'tag_menu', title: '🏷️ My tags' }, { id: 'menu', title: 'Menu' }]);
    return;
  }
  await db.query(`UPDATE tag_messages SET replies = replies + 1, last_reply = $2, last_reply_at = now() WHERE id = $1`, [m.id, reply.slice(0, 300)]);
  await buttons(mobile, '✅ *Sent.* They\'ll see your reply in their chat — your number stays private.',
    [{ id: `tag_rp:${m.id}`, title: '↩️ Reply again' }, { id: 'menu', title: 'Menu' }]);
}

async function block(mobile, id, { report = false } = {}) {
  const m = await ownersMessage(mobile, id);
  if (!m) { await send.text(mobile, 'That message is no longer available.'); return; }
  await db.query(
    `INSERT INTO tag_blocks (owner_user_id, sender_mobile, message_id, reported) VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_user_id, sender_mobile) DO UPDATE SET reported = tag_blocks.reported OR EXCLUDED.reported`,
    [m.user_id, m.sender_mobile, m.id, report]);
  if (report) {
    require('../util/adminPing').ping({
      key: `tag_report:${m.id}`, severity: 'warning', source: 'tags',
      title: `⚠️ GaadiPe Tag misuse reported — ${m.reg_no}`,
      text: `The owner reported message #${m.id} ("${m.reason}") from ••${m.sender_mobile.slice(-4)}. The sender is blocked from this owner's tags. Review on the admin Tags page.`,
    }).catch(() => {});
  }
  await buttons(mobile, report
    ? '⚠️ *Reported and blocked.* This person can\'t message you again, and our team will look into it. Thank you.'
    : '🚫 *Blocked.* This person can\'t message you through your GaadiPe Tag again.',
    [{ id: 'tag_menu', title: '🏷️ My tags' }, { id: 'menu', title: 'Menu' }]);
}

/* ─────────────────────────────── the owner's tags ─────────────────────────────── */

async function menu(mobile) {
  const user = await userOf(mobile);
  const vehicles = user ? await T.vehiclesOf(user.id) : [];
  if (!vehicles.length) {
    await buttons(mobile, '🏷️ *GaadiPe Tag* lets anyone reach you about your vehicle — blocking, lights on, towing — without seeing your number.\n\nFirst send your vehicle\'s number (like *KA01AB1234*) to add it.',
      [{ id: 'check_another', title: 'Check vehicle' }, { id: 'menu', title: 'Menu' }]);
    return;
  }
  const out = await send.list(mobile, {
    body: '🏷️ *GaadiPe Tag* — let anyone reach you about your vehicle (blocking, lights on, being towed…) *without seeing your number*.\n\nPick a vehicle:',
    button: 'My vehicles', sectionTitle: 'Your vehicles',
    rows: vehicles.map((v) => ({
      id: `tagv:${v.vehicle_id}`, title: v.reg_no,
      description: v.code ? `Tag ${v.code} · QR again, sticker, switch off` : 'Make a free tag for this vehicle',
    })),
  }).catch(() => ({ ok: false }));
  if (!out.ok) await send.text(mobile, 'Sorry — something went wrong. Please type *tag* again.').catch(() => {});
}

async function forVehicle(mobile, vehicleId) {
  const user = await userOf(mobile);
  const mine = user && await db.one(`SELECT 1 AS x FROM user_vehicles WHERE user_id = $1 AND vehicle_id = $2 AND hidden_at IS NULL`, [user.id, Number(vehicleId) || 0]);
  if (!mine) { await send.text(mobile, 'That vehicle isn\'t in your list.'); return; }
  const { tag, created } = await T.getOrCreate(user.id, Number(vehicleId));
  const full = await T.byCode(tag.code);
  await card(mobile, full, { created });
}

async function card(mobile, tag, { created = false } = {}) {
  const file = await require('./qr').cardPdf(tag);
  await send.document(mobile, file, { filename: `GaadiPe-Tag-${tag.code}.pdf`, caption: `🏷️ GaadiPe Tag · ${T.masked(tag.reg_no)} · ${tag.code}` }).catch(() => {});
  const p = (await require('./orders').priceFor(2)).pricing;
  await buttons(mobile,
    `${created ? '✅ *Your GaadiPe Tag is ready!*' : '🏷️ *Your GaadiPe Tag*'} — ${T.masked(tag.reg_no)}\n\n`
    + 'Print the QR above at any shop (₹5–10) and stick it on the *rear windscreen or a side window*. When someone scans it, '
    + 'their message comes here — your number stays private.\n\n'
    + `Want printed, weatherproof stickers delivered? *${p.min} for ₹${p.base}*, GST and delivery included.`,
    [{ id: `tag_ord:${tag.code}`, title: '📦 Order sticker' }, { id: `tag_off:${tag.code}`, title: '🔕 Switch off' }, { id: 'menu', title: 'Menu' }]);
}

async function ownTag(mobile, code) {
  const tag = await T.byCode(code);
  return tag && T.ten(tag.owner_mobile) === T.ten(mobile) && tag.is_active ? tag : null;
}

async function askOff(mobile, code) {
  const tag = await ownTag(mobile, code);
  if (!tag) { await send.text(mobile, 'That tag is not active.'); return; }
  await buttons(mobile, `🔕 Switch off the tag for ${T.masked(tag.reg_no)}?\n\nThe QR stops working at once — use this if the sticker is lost or the vehicle is sold. You can make a new tag any time.`,
    [{ id: `tag_offy:${tag.code}`, title: 'Yes, switch off' }, { id: 'tag_menu', title: 'Keep it' }]);
}

async function doOff(mobile, code) {
  const user = await userOf(mobile);
  const ok = user && await T.switchOff(String(code).toUpperCase(), user.id);
  await buttons(mobile, ok ? '✅ Switched off. That QR no longer reaches you.' : 'That tag was already switched off.',
    [{ id: 'tag_menu', title: '🏷️ My tags' }, { id: 'menu', title: 'Menu' }]);
}

/* ─────────────────────────────── the delivered sticker ─────────────────────────────── */

/* HOW MANY (user, 2026-10-29: "2 mandatory, any vehicle, ₹149 inclusive of GST, ₹49 per extra"; migration 220). */
async function askQty(mobile, code) {
  const tag = await ownTag(mobile, code);
  if (!tag) { await send.text(mobile, 'That tag is not active.'); return; }
  const O = require('./orders');
  const opts = [];
  for (const n of [2, 3, 4]) opts.push({ n, ...(await O.priceFor(n)) });
  const p = opts[0].pricing;
  await buttons(mobile,
    `📦 *Printed weatherproof stickers* — ${T.masked(tag.reg_no)}\n\n`
    + `*${p.min} stickers for ₹${p.base}*, then ₹${p.extra} for each extra — GST and delivery included.\n`
    + `_A car needs 2: rear windscreen + a side window. Up to ${p.max}? Type the number._`,
    opts.map((o) => ({ id: `tag_q:${tag.code}:${o.qty}`, title: `${o.qty} · ₹${o.rupees}` })));
  await enter(mobile, 'tag_qty', { tag_code: tag.code });
}

async function askPincode(mobile, code, qty) {
  const tag = await ownTag(mobile, code);
  if (!tag) { await leave(mobile); await send.text(mobile, 'That tag is not active.'); return; }
  const { qty: n, rupees } = await require('./orders').priceFor(qty);
  await enter(mobile, 'tag_pin', { tag_code: tag.code, tag_qty: n });
  await send.text(mobile, `📦 *${n} stickers — ₹${rupees}* for ${T.masked(tag.reg_no)}\n\nType your *6-digit pincode* for delivery.\n\n_Type *menu* to cancel._`);
}

async function quotePin(mobile, text) {
  const s = await ctx(mobile);
  const q = await require('./orders').quote(String(text).replace(/\D/g, ''), s.context?.tag_qty);
  if (!q) { await send.text(mobile, 'Please type a valid 6-digit pincode, like *560013* — or *menu* to cancel.'); return; }
  if (q.unserviceable) {
    await send.text(mobile, `😕 Sorry — our courier doesn't deliver to *${q.pincode}* yet. Try another pincode (office or a relative's), or use the free digital tag above — print it at any shop.`);
    return;
  }
  await setState(mobile, 'tag_pin', { tag_pin: q.pincode });
  await buttons(mobile,
    `📦 *${q.qty} stickers* to *${q.pincode}* (${q.label}): *₹${q.rupees}*\n_GST and delivery included · arrives in about ${q.days} days after posting._`,
    [{ id: 'tag_ord_ok', title: '✅ Continue' }, { id: 'tag_ord_no', title: 'Cancel' }]);
}

async function askAddress(mobile) {
  const s = await ctx(mobile);
  if (!s.context?.tag_pin || !s.context?.tag_code) { await leave(mobile); await menu(mobile); return; }
  await setState(mobile, 'tag_addr');
  await send.text(mobile, '🏠 Type your *name and full address* in one message — house/flat, street, area and city.\n\n_e.g. Ravi Kumar, 12 3rd Cross, Jalahalli, Bengaluru_');
}

async function placeOrder(mobile, text) {
  const s = await ctx(mobile);
  const addr = String(text || '').replace(/\s+/g, ' ').trim();
  if (addr.length < 15) { await send.text(mobile, 'Please type your *name and full address* (at least house, street and area).'); return; }
  const tag = await ownTag(mobile, s.context?.tag_code);
  const user = await userOf(mobile);
  if (!tag || !user) { await leave(mobile); await send.text(mobile, 'That tag is not active.'); return; }
  const name = addr.split(/[,\n]/)[0].trim().slice(0, 80);
  let out;
  try {
    out = await require('./orders').startOrder({ user, tag, pincode: s.context.tag_pin, name, address: addr, qty: s.context.tag_qty });
  } catch (e) {
    console.error('[tag] sticker order failed: %s', e.message);
    await leave(mobile);
    await send.text(mobile, '😕 Sorry — I could not start the payment just now. Please try again in a few minutes.');
    return;
  }
  await leave(mobile);
  const url = `${(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/pay/${out.payment.checkout_token}`;
  const body = `🧾 *${out.quote.qty} stickers for ${T.masked(tag.reg_no)} — ₹${out.quote.rupees}*\n\nDelivered to: ${addr} — ${out.quote.pincode}\n\n`
    + '✅ Pay with *UPI* — GPay, PhonePe, Paytm — or card\n✅ Secure checkout by *Razorpay* · GST invoice included\n\n'
    + '_GaadiPe never asks for your PIN or OTP._';
  const link = await send.ctaUrl(mobile, body, { text: `Pay ₹${out.quote.rupees} securely`, url }, { footer: 'GaadiPe · secure checkout by Razorpay' })
    .catch(() => ({ ok: false }));
  if (!link.ok) await send.text(mobile, `${body}\n\n${url}`).catch(() => {});
}

/* ─────────────────────────────── the router ─────────────────────────────── */

/** flow.js calls this first. True = answered here. */
async function handle(session, message, mobile, intent) {
  const id = String(intent.id || '');
  const text = String(intent.text || '');

  // The person who scanned: "TAG K7Q2XM", typed or from the QR.
  if (intent.kind === 'text' && TAG_TEXT.test(text)) { await startScan(mobile, TAG_TEXT.exec(text)[1].toUpperCase()); return true; }

  if (intent.kind === 'button' && /^tag[_v]/.test(id)) {
    const [head, a, b] = id.split(':');
    switch (head) {
      case 'tag_ok':     await reasons(mobile, a, { agreed: true }); return true;
      case 'tag_more':   await reasons(mobile, a); return true;
      case 'tag_cancel': await send.text(mobile, 'No problem 🙂 Nothing was sent.'); return true;
      case 'tag_wrong':  await wrongVehicle(mobile, a); return true;
      case 'tag_r':      await relay(mobile, a, b); return true;
      case 'tag_rp':     await askReply(mobile, a); return true;
      case 'tag_bk':     await block(mobile, a); return true;
      case 'tag_rt':     await block(mobile, a, { report: true }); return true;
      default: break;
    }
    // The owner's own tag pages: only while tags are on for them.
    if (!(await T.enabledFor(mobile))) return false;
    switch (head) {
      case 'tag_menu':   await menu(mobile); return true;
      case 'tagv':       await forVehicle(mobile, a); return true;
      case 'tag_off':    await askOff(mobile, a); return true;
      case 'tag_offy':   await doOff(mobile, a); return true;
      case 'tag_ord':    await askQty(mobile, a); return true;
      case 'tag_q':      await askPincode(mobile, a, b); return true;
      case 'tag_ord_ok': await askAddress(mobile); return true;
      case 'tag_ord_no': await leave(mobile); await buttons(mobile, 'No problem — no order placed.', [{ id: 'tag_menu', title: '🏷️ My tags' }, { id: 'menu', title: 'Menu' }]); return true;
      default: return false;
    }
  }

  // The tag steps that wait for typing.
  const state = String(session?.state || (await ctx(mobile)).state || '');
  if (state.startsWith('tag_')) {
    if (intent.kind !== 'text' || ESCAPE.test(text)) { await leave(mobile); return false; }   // anything else: back to the usual flow
    if (state === 'tag_reply') { await sendReply(mobile, text); return true; }
    if (state === 'tag_qty') {
      const n = Number(String(text).replace(/\D/g, ''));
      const p = (await require('./orders').priceFor(2)).pricing;
      if (!n || n < p.min || n > p.max) { await send.text(mobile, `Please type a number from ${p.min} to ${p.max} — or *menu* to cancel.`); return true; }
      await askPincode(mobile, (await ctx(mobile)).context?.tag_code, n);
      return true;
    }
    if (state === 'tag_pin') { await quotePin(mobile, text); return true; }
    if (state === 'tag_addr') { await placeOrder(mobile, text); return true; }
    await leave(mobile);
    return false;
  }

  // "tag" / "my tags" typed by someone it is on for.
  if (intent.kind === 'text' && MENU_WORDS.test(text) && await T.enabledFor(mobile)) { await menu(mobile); return true; }
  return false;
}

module.exports = { handle, menu };
