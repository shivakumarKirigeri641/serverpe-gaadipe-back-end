/**
 * src/jobs/expiryWatch.js — warning people before a document runs out
 * (user, 2026-09-23).
 *
 * THIS IS THE THING AN OWNER ACTUALLY BUYS. The people arriving are not
 * used-vehicle buyers; they are owners checking their own two-wheeler. An owner
 * does not want a document — he wants to not be stopped by a policeman, and to
 * not discover his insurance lapsed three weeks ago. Parivahan has the date and
 * never tells him. This is GaadiPe telling him.
 *
 * WHY IT COSTS ALMOST NOTHING. Expiry dates are already stored on the vehicle
 * from the report he paid for, and they do not move on their own. So warning
 * him needs no daily polling at all: we read the stored date, and spend ONE RC
 * call at the moment of warning — to make sure he has not already renewed, so
 * GaadiPe never nags someone about a policy they bought last week. The cost is
 * proportional to warnings sent (two or three a year), not to time passing.
 *
 * That is why the promise has no end date while the challan watch has one:
 * challans genuinely change and must be polled; expiry dates do not.
 *
 * THREE WARNINGS, NOT ONE (expiry_warn_days, 30/7/1). A single message a month
 * ahead is forgotten; one on the day is too late to act on. Each is sent once,
 * keyed on the DATE as well as the document — when he renews, the new date is a
 * new expiry and earns its own warning next year.
 *
 * WHO IS WARNED: someone who has paid, for as long as expiry_warning_months
 * (18) after their last payment. One ₹19 does not oblige GaadiPe for ever.
 *
 * TEST MODE APPLIES, as everywhere: email goes through mail/customer.deliver()
 * and WhatsApp through whatsapp/send, so while customer_email_only_to and
 * WHATSAPP_ALLOWED_RECEPIENTS hold addresses, nobody else can be reached.
 */

const db = require('../db');
const settings = require('../util/settings');
const gateway = require('../vehicle/gateway');
const C = require('../mail/customer');
const T = require('../mail/templates');
const { config } = require('../config');

/** The documents we warn about, and where each date lives on the vehicle. */
const DOCUMENTS = [
  { key: 'insurance', column: 'insurance_upto', label: 'Insurance' },
  { key: 'pucc',      column: 'pucc_upto',      label: 'PUC' },
  { key: 'tax',       column: 'tax_upto',       label: 'Road tax' },
  { key: 'fitness',   column: 'fitness_upto',   label: 'Fitness' },
  { key: 'permit',    column: 'permit_upto',    label: 'Permit' },
];

const istDay = C.istDay;

/*
 * EVERY DATE HERE IS INDIA'S DATE.
 *
 * An expiry is a calendar day in India, and the database hands it back as an
 * instant — "25 Oct 18:30 UTC", which IS 26 Oct in Delhi. Comparing that with
 * toISOString() reads the 25th, while the same date fetched fresh reads the
 * 26th, and the job concludes the customer renewed when nothing changed at all.
 * Left alone it would have warned precisely nobody, quietly, for ever.
 *
 * So: one helper, used for every comparison and every stored key.
 */
const IST = 5.5 * 3600 * 1000;
const istKey = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
/** Whole days from today to that date, both in India's calendar. */
const daysUntil = (d) => Math.round(
  (Date.parse(`${istKey(d)}T00:00:00Z`) - Date.parse(`${istKey(Date.now())}T00:00:00Z`)) / 86400000);

/** 30,7,1 -> [30, 7, 1], largest first. */
async function thresholds() {
  return String(await settings.get('expiry_warn_days', '30,7,1'))
    .split(/[,\s]+/).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => b - a);
}

/**
 * Everyone owed a warning: a paying customer's vehicle with a date coming up.
 *
 * The window is deliberately generous at the front — a date 30 days out is
 * picked up, and one that has just passed is too, because "expired 2 days ago"
 * is the most useful message of all.
 */
async function candidates(limit = 20) {
  const months = await settings.num('expiry_warning_months', 18);
  const list = await thresholds();
  const widest = list[0] || 30;

  const columns = DOCUMENTS.map((d) => `v.${d.column}`).join(', ');
  const { rows } = await db.query(
    `SELECT DISTINCT ON (uv.user_id, uv.vehicle_id)
            uv.user_id, uv.vehicle_id, v.reg_no, ${columns},
            u.email, u.email_verified_at, u.email_unsubscribed_at, u.display_name,
            u.email_token, u.mobile, u.is_paused, u.preferred_language
       FROM user_vehicles uv
       JOIN vehicles v ON v.id = uv.vehicle_id
       JOIN users    u ON u.id = uv.user_id
      WHERE u.deactivated_at IS NULL AND NOT u.is_paused
        -- Only someone who paid, and only for a while after they last did.
        AND EXISTS (SELECT 1 FROM payments p
                     WHERE p.user_id = uv.user_id AND p.status = 'paid'
                       AND p.paid_at > now() - ($1 || ' months')::interval)
        -- …and only if some document is near its date.
        AND (${DOCUMENTS.map((d, i) => `(v.${d.column} IS NOT NULL
              AND v.${d.column} <= (CURRENT_DATE + $2::int)
              AND v.${d.column} >= (CURRENT_DATE - 7))`).join(' OR ')})
      ORDER BY uv.user_id, uv.vehicle_id, uv.last_checked_at DESC
      LIMIT $3`, [String(months), widest, limit]);
  return rows;
}

/** Which warning is owed for this vehicle, if any: the tightest not yet sent. */
async function owed(row, list) {
  for (const doc of DOCUMENTS) {
    const date = row[doc.column];
    if (!date) continue;
    const days = daysUntil(date);
    if (days > list[0]) continue;              // still far away
    if (days < -7) continue;                   // long gone; nagging helps nobody

    /*
     * THE TIGHTEST THRESHOLD THIS DATE HAS REACHED, never a wider one. At 5
     * days left the warning owed is the 7-day one, not the 30-day one — and if
     * that has already gone, nothing is owed until the 1-day mark. Falling back
     * to a wider step would send "expires in 30 days" to someone with 5 left.
     */
    const reached = list.filter((t) => days <= t);
    if (!reached.length) continue;
    const step = Math.min(...reached);

    const already = await db.one(
      `SELECT 1 FROM expiry_warnings
        WHERE vehicle_id = $1 AND user_id = $2 AND document = $3
          AND valid_until = $4::date AND days_before = $5`,
      [row.vehicle_id, row.user_id, doc.key, istKey(date), step]);
    if (already) continue;

    return { doc, date, days, step };
  }
  return null;
}

/**
 * Confirm the date before saying anything.
 *
 * ONE CALL, AND ONLY WHEN WE ARE ABOUT TO SPEAK. He may have renewed the day
 * after the report was issued; telling him his insurance expires when he is
 * holding the new policy is the fastest way to be unsubscribed from. Returns
 * the date as the Government has it today, or null if the lookup failed.
 */
async function confirm(regNo, doc) {
  let data;
  try { data = await gateway.rc(regNo); } catch (e) { return null; }
  if (!data?.success) return null;

  const rc = data.rc || data;
  const FIELDS = {
    insurance: ['insurance_upto', 'insuranceUpto', 'insurance_valid_upto'],
    pucc:      ['pucc_upto', 'puccUpto', 'pollution_valid_upto'],
    tax:       ['tax_upto', 'taxUpto'],
    fitness:   ['fitness_upto', 'fitnessUpto', 'rc_fit_upto'],
    permit:    ['permit_upto', 'permitUpto', 'permit_valid_upto'],
  };
  for (const f of FIELDS[doc.key] || []) {
    const v = rc[f] ?? rc?.data?.[f];
    if (v) return new Date(v);
  }
  return null;
}

/* ───────────────────────────────────────────────────────── the message ── */

function mailFor(user, { regNo, doc, date, days }) {
  const name = String(user.display_name || '').split(' ')[0] || 'there';
  const gone = days < 0;
  const when = gone
    ? `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
    : days === 0 ? 'expires today'
    : `expires in ${days} day${days === 1 ? '' : 's'}`;
  const site = C.SITE();

  const out = T.layout({
    tagline: 'Before it runs out',
    preheader: `${doc.label} on ${regNo} ${when}.`,
    badge: { text: gone ? 'Expired' : 'Expiring', tone: gone ? 'wrong' : 'watch' },
    title: `${doc.label} on ${regNo} ${when}`,
    lead: `Hi ${name}, the ${doc.label.toLowerCase()} for your vehicle ${regNo} `
      + `${gone ? 'has expired' : `is valid until ${istDay(date)}`}.`,
    stats: [['Vehicle', regNo], [doc.label, istDay(date)],
            [gone ? 'Expired' : 'Days left', gone ? `${Math.abs(days)}d ago` : String(days)]],
    blocks: [`<div style="font-size:13px;line-height:1.7;color:#0b1f1c;background:${gone ? '#fdecea' : '#fff6e6'};
      border-left:4px solid ${gone ? '#b42318' : '#e08700'};border-radius:8px;padding:12px 14px;">
      ${gone
        ? `Driving with expired ${doc.label.toLowerCase()} can mean a fine at a check post, and an insurance claim that is refused.`
        : `Renew before ${T.esc(istDay(date))} and you will not have to think about it again — we will tell you next time too.`}
      </div>`,
      `<div style="font-size:13px;line-height:1.6;color:#41514e;">
        This is from the Government record (VAHAN) checked today. If you have already renewed and it still shows the old date,
        the RTO record can take a few days to update.</div>`],
    cta: { label: 'See the full record', url: `${site}/app/vehicle/${encodeURIComponent(regNo)}` },
    footer: 'You are receiving this because you bought a GaadiPe report for this vehicle, which includes expiry warnings.',
    footerHtml: user.email_token ? `<a href="${T.esc(`${C.API()}/email/unsubscribe/${user.email_token}`)}" style="color:#0f766e;">Unsubscribe</a>` : '',
  });
  return { subject: `${doc.label} on ${regNo} ${when} — GaadiPe`, ...out };
}

function whatsappFor({ regNo, doc, date, days }) {
  const gone = days < 0;
  const when = gone ? `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
    : days === 0 ? 'expires *today*' : `expires in *${days} day${days === 1 ? '' : 's'}*`;
  return `${gone ? '⚠️' : '🔔'} *${doc.label}* on *${regNo}* ${when}.\n\n`
    + `Valid until: ${istDay(date)}\n\n`
    + (gone
      ? 'Driving without it can mean a fine, and a claim that is refused.'
      : 'Renew before then and you are covered. I will remind you next time too.')
    + '\n\nReply *report* for the full record.';
}

/* ──────────────────────────────────────────────────────────── the pass ── */

async function runOnce({ limit = 20 } = {}) {
  if (String(await settings.get('expiry_warnings_enabled', 'true')).toLowerCase() === 'false') {
    return { off: true };
  }
  const list = await thresholds();
  const rows = await candidates(limit);
  let warned = 0;
  let looked = 0;

  for (const row of rows) {
    const need = await owed(row, list);
    if (!need) continue;

    // One call, right before speaking: has he already renewed?
    looked += 1;
    const fresh = await confirm(row.reg_no, need.doc);
    if (fresh) {
      const freshDay = istKey(fresh);
      const storedDay = istKey(need.date);
      if (freshDay !== storedDay) {
        // He renewed. Store the new date and say nothing — the new date will
        // earn its own warning when it comes round.
        await db.query(
          `UPDATE vehicles SET ${need.doc.column} = $2, last_seen_at = now() WHERE id = $1`,
          [row.vehicle_id, freshDay]);
        console.log('[expiry] %s %s now %s — renewed, not warning', row.reg_no, need.doc.key, freshDay);
        continue;
      }
    }

    // Recorded BEFORE sending: a message that went out and was not recorded
    // would be sent again tomorrow, and twice is worse than late.
    const claimed = await db.one(
      `INSERT INTO expiry_warnings (user_id, vehicle_id, document, valid_until, days_before, channel)
       VALUES ($1, $2, $3, $4::date, $5, $6)
       ON CONFLICT (vehicle_id, user_id, document, valid_until, days_before) DO NOTHING
       RETURNING id`,
      [row.user_id, row.vehicle_id, need.doc.key, istKey(need.date), need.step, 'email']);
    if (!claimed) continue;                  // someone else got there first

    const payload = { regNo: row.reg_no, doc: need.doc, date: need.date, days: need.days };

    // Email, if the address is confirmed and still subscribed.
    if (row.email && row.email_verified_at && !row.email_unsubscribed_at) {
      const out = await C.deliver(row.email, mailFor(row, payload), row.email_token);
      if (out.ok) warned += 1;
      else if (!out.skipped) console.warn('[expiry] email failed for %s: %s', row.reg_no, out.error);
    }

    // WhatsApp, only once GaadiPe has a number of its own.
    if (config.whatsapp.enabled) {
      const send = require('../whatsapp/send');
      await send.text(row.mobile, whatsappFor(payload)).catch(() => {});
    }
  }

  if (warned || looked) console.log('[expiry] %d warning(s) sent, %d lookup(s)', warned, looked);
  return { warned, looked, considered: rows.length };
}

function start(everySeconds = 3600) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runOnce(); } catch (e) { console.error('[expiry] pass failed:', e.message); }
    finally { running = false; }
  };
  setInterval(tick, everySeconds * 1000).unref();
  setTimeout(tick, 20000).unref();
  console.log(`  expiry warning job: every ${everySeconds}s`);
}

module.exports = { start, runOnce, candidates, owed, thresholds, DOCUMENTS };
