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

/** Where each date hides in the RC, whatever the upstream calls it that day. */
const FIELDS = {
  insurance: ['insurance_upto', 'insuranceUpto', 'insurance_valid_upto'],
  pucc:      ['pucc_upto', 'puccUpto', 'pollution_valid_upto'],
  tax:       ['tax_upto', 'taxUpto'],
  fitness:   ['fitness_upto', 'fitnessUpto', 'rc_fit_upto'],
  permit:    ['permit_upto', 'permitUpto', 'permit_valid_upto'],
};

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
 * Everyone owed a warning: a vehicle being monitored, with a date coming up.
 *
 * The window is deliberately generous at the front — a date 30 days out is
 * picked up, and one that has just passed is too, because "expired 2 days ago"
 * is the most useful message of all.
 *
 * WARNINGS STOP WHEN MONITORING STOPS (user, 2026-09-23). They used to run for
 * months after a payment, which was generous and also why nobody would ever
 * renew: a customer warned for free for ever has bought everything he needs.
 * So the subscription decides. expiry_warning_months is a grace period on top
 * — 0 today, and the one dial to turn if renewals do not sell.
 */
async function candidates(limit = 20) {
  const months = await settings.num('expiry_warning_months', 0);
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
        -- Only while this vehicle is actually being monitored (plus any grace).
        AND EXISTS (SELECT 1 FROM subscriptions sb
                     WHERE sb.user_id = uv.user_id AND sb.vehicle_id = uv.vehicle_id
                       AND sb.ends_on >= (CURRENT_DATE - ($1 || ' months')::interval))
        -- …and only if some document is near its date.
        AND (${DOCUMENTS.map((d, i) => `(v.${d.column} IS NOT NULL
              AND v.${d.column} <= (CURRENT_DATE + $2::int)
              AND v.${d.column} >= (CURRENT_DATE - 7))`).join(' OR ')})
      ORDER BY uv.user_id, uv.vehicle_id, uv.last_checked_at DESC
      LIMIT $3`, [String(months), widest, limit]);
  return rows;
}

/**
 * EVERY document owed a warning on this vehicle, not merely the first.
 *
 * One message listing all of them beats three arriving together: the customer
 * reads it once, and WhatsApp's template carries the whole list in a single
 * parameter anyway.
 */
async function owedAll(row, list) {
  const all = [];
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

    all.push({ doc, date, days, step });
  }
  return all;
}

/** The first thing owed, kept for callers that want one. */
async function owed(row, list) {
  const all = await owedAll(row, list);
  return all.length ? all[0] : null;
}

/**
 * Confirm the date before saying anything.
 *
 * ONE CALL, AND ONLY WHEN WE ARE ABOUT TO SPEAK. He may have renewed the day
 * after the report was issued; telling him his insurance expires when he is
 * holding the new policy is the fastest way to be unsubscribed from. Returns
 * the date as the Government has it today, or null if the lookup failed.
 */
async function confirmAll(regNo) {
  const out = {};
  let data;
  try { data = await gateway.rc(regNo); } catch (e) { return out; }
  if (!data?.success) return out;
  const rc = data.rc || data;
  for (const doc of DOCUMENTS) {
    for (const f of (FIELDS[doc.key] || [])) {
      const v = rc[f] ?? rc?.data?.[f];
      if (v) { out[doc.key] = new Date(v); break; }
    }
  }
  return out;
}

async function confirm(regNo, doc) {
  let data;
  try { data = await gateway.rc(regNo); } catch (e) { return null; }
  if (!data?.success) return null;

  const rc = data.rc || data;
  for (const f of FIELDS[doc.key] || []) {
    const v = rc[f] ?? rc?.data?.[f];
    if (v) return new Date(v);
  }
  return null;
}

/* ───────────────────────────────────────────────────────── the message ── */

/** "expires in 7 days (30 Sep 2026)" — how a date reads to a person. */
function phrase({ date, days }) {
  if (days < 0) return `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago (${istDay(date)})`;
  if (days === 0) return `expires today (${istDay(date)})`;
  return `expires in ${days} day${days === 1 ? '' : 's'} (${istDay(date)})`;
}

/**
 * Every document on ONE line.
 *
 * WhatsApp refuses a template parameter containing a line break (#132018),
 * and it fails the whole message rather than the parameter — so the list is
 * joined with a separator, never with newlines.
 */
function documentLine(due) {
  return due.map((d) => `${d.doc.label} — ${phrase(d)}`).join(' · ') || '—';
}

/** What to do about it. Never empty: an empty parameter fails too. */
function adviceLine(due) {
  const gone = due.filter((d) => d.days < 0).map((d) => d.doc.label);
  const soon = due.filter((d) => d.days >= 0).map((d) => d.doc.label);
  if (gone.length && soon.length) {
    return `Renew ${gone.join(' and ')} now, and ${soon.join(' and ')} before the date above.`;
  }
  if (gone.length) {
    return `Driving without valid ${gone.join(' and ')} can mean a fine at a check post, `
      + 'and an insurance claim that is refused.';
  }
  if (soon.length) {
    return `Renew ${soon.join(' and ')} before the date above and you are covered. `
      + 'We will tell you next time too.';
  }
  return '—';
}

/**
 * The same thing by email, where a list can be a list.
 *
 * Email has no template to satisfy and no parameter rules, so each document
 * gets its own row rather than being crammed onto one line.
 */
function mailFor(user, regNo, due) {
  const name = String(user.display_name || '').split(' ')[0] || 'there';
  const worst = due.reduce((a, b) => (b.days < a.days ? b : a), due[0]);
  const gone = worst.days < 0;
  const site = C.SITE();

  const rows = due.map((d) => [d.doc.label, {
    html: `<span style="color:${d.days < 0 ? '#b42318' : '#b54708'};font-weight:700;">${T.esc(phrase(d))}</span>`,
    text: phrase(d),
  }]);

  const out = T.layout({
    tagline: 'Before it runs out',
    preheader: `${regNo}: ${documentLine(due)}`,
    badge: { text: gone ? 'Expired' : 'Expiring', tone: gone ? 'wrong' : 'watch' },
    title: due.length === 1
      ? `${worst.doc.label} on ${regNo} ${phrase(worst)}`
      : `${due.length} documents on ${regNo} need attention`,
    lead: `Hi ${name}, here is what is about to run out on your vehicle ${regNo}.`,
    sections: [{ heading: `${regNo} — from today's Government record`, rows }],
    blocks: [`<div style="font-size:13px;line-height:1.7;color:#0b1f1c;background:${gone ? '#fdecea' : '#fff6e6'};
      border-left:4px solid ${gone ? '#b42318' : '#e08700'};border-radius:8px;padding:12px 14px;">
      ${T.esc(adviceLine(due))}</div>`,
      `<div style="font-size:13px;line-height:1.6;color:#41514e;">
        Checked against the Government record (VAHAN) today. If you have already renewed and it still shows the old
        date, the RTO record can take a few days to catch up.</div>`],
    cta: { label: 'See the full record', url: `${site}/app/vehicle/${encodeURIComponent(regNo)}` },
    footer: 'You are receiving this because you bought a GaadiPe report for this vehicle, which includes monitoring.',
    footerHtml: user.email_token
      ? `<a href="${T.esc(`${C.API()}/email/unsubscribe/${user.email_token}`)}" style="color:#0f766e;">Unsubscribe</a>`
      : '',
  });
  const subject = due.length === 1
    ? `${worst.doc.label} on ${regNo} ${phrase(worst)} — GaadiPe`
    : `${regNo}: ${due.length} documents need attention — GaadiPe`;
  return { subject, ...out };
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
    const owedHere = await owedAll(row, list);
    if (!owedHere.length) continue;

    /*
     * CONFIRM EACH ONE BEFORE SAYING ANY OF THEM.
     *
     * One RC call covers the whole vehicle, so checking three documents
     * costs what checking one costs. Anything he has already renewed is
     * written back and dropped from the message — telling a man his
     * insurance expires while he holds the new policy is how an alert
     * service gets muted.
     */
    looked += 1;
    const fresh = await confirmAll(row.reg_no);
    const due = [];
    for (const need of owedHere) {
      const current = fresh[need.doc.key];
      if (current && istKey(current) !== istKey(need.date)) {
        await db.query(
          `UPDATE vehicles SET ${need.doc.column} = $2, last_seen_at = now() WHERE id = $1`,
          [row.vehicle_id, istKey(current)]);
        console.log('[expiry] %s %s now %s — renewed, not warning',
          row.reg_no, need.doc.key, istKey(current));
        continue;
      }
      due.push(need);
    }
    if (!due.length) continue;

    // Recorded BEFORE sending: a message that went out and was not recorded
    // would be sent again tomorrow, and twice is worse than late.
    const claimed = [];
    for (const need of due) {
      const row2 = await db.one(
        `INSERT INTO expiry_warnings (user_id, vehicle_id, document, valid_until, days_before, channel)
         VALUES ($1, $2, $3, $4::date, $5, $6)
         ON CONFLICT (vehicle_id, user_id, document, valid_until, days_before) DO NOTHING
         RETURNING id`,
        [row.user_id, row.vehicle_id, need.doc.key, istKey(need.date), need.step,
         config.whatsapp.enabled ? 'whatsapp' : 'email']);
      if (row2) claimed.push(need);
    }
    if (!claimed.length) continue;        // another pass got there first

    // Email, if the address is confirmed and still subscribed.
    if (row.email && row.email_verified_at && !row.email_unsubscribed_at) {
      const out = await C.deliver(row.email, mailFor(row, row.reg_no, claimed), row.email_token);
      if (out.ok) warned += 1;
      else if (!out.skipped) console.warn('[expiry] email failed for %s: %s', row.reg_no, out.error);
    }

    // WhatsApp, once GaadiPe has a number: the approved template, one message,
    // every document on one line because a parameter may not contain a newline.
    if (config.whatsapp.enabled) {
      const send = require('../whatsapp/send');
      const name = String(row.display_name || row.wa_profile_name || '').split(' ')[0] || 'there';
      const out = await send.template(row.mobile, await settings.get('wa_template_monitoring', 'gp_monitoring_alert_en_v1'),
        [name, row.reg_no, documentLine(claimed), adviceLine(claimed)],
        { language: await settings.get('wa_template_language', 'en') }).catch(() => ({ ok: false }));
      if (out.ok) warned += 1;
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
  // Heartbeat: System health and the alert checker see when this last ran.
  setInterval(require('../util/heartbeat').wrap('expiryWatch', tick, everySeconds), everySeconds * 1000).unref();
  setTimeout(tick, 20000).unref();
  console.log(`  expiry warning job: every ${everySeconds}s`);
}

module.exports = { start, runOnce, candidates, owed, owedAll, thresholds,
                   documentLine, adviceLine, phrase, DOCUMENTS };
